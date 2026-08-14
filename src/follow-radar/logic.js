// X-Tools 关注雷达 — pure logic (no DOM / chrome / storage).
//
// Relationship state machine for leaderboard capsules:
//   rec: { n: display name, f: 0|1 (I follow them), b: 0|1 (they follow me),
//          fc: followers_count, fd: friends_count (their following),
//          t: lastSeen ts, u: ts they unfollowed me, i: ts I unfollowed them,
//          m: ts when a mutual relationship was first broken }
//   capsule: 互关 (f&&b) · 我关注 (f) · 关注我 (b) · 取关 (u|i, no current link) · 关注率 (none)
//
// Exposed as window.__xvmFollowRadarLogic so radar.js and unit tests share it.

(() => {
  if (window.__xvmFollowRadarLogic) return;
  const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

  function normalizeHandle(h) {
    if (h == null) return null;
    h = String(h).trim().replace(/^@/, '').toLowerCase();
    return HANDLE_RE.test(h) ? h : null;
  }

  // Classify a user record into a capsule state.
  //   mutual | mine | theirs | unfollowed | none
  function classify(rec) {
    if (!rec) return 'none';
    const f = rec.f === 1 || rec.f === true;
    const b = rec.b === 1 || rec.b === true;
    if (f && b) return 'mutual';
    // Once a mutual relationship existed, either side breaking it is a
    // historical unfollow even if the remaining direction is still active.
    if (rec.m || (rec.u && f) || (rec.i && b)) return 'unfollowed';
    if (f) return 'mine';
    if (b) return 'theirs';
    if (rec.u || rec.i) return 'unfollowed';
    return 'none';
  }

  // Follow ratio = their following ÷ their followers (关注/粉丝比), 2 decimals.
  // null when followers count is unknown/zero.
  function computeRate(rec) {
    if (!rec) return null;
    const observedRate = Number(rec.r);
    if (Number.isFinite(observedRate) && observedRate >= 0) return Math.round(observedRate * 100) / 100;
    const fc = Number(rec.fc) || 0;
    const fd = Number(rec.fd) || 0;
    if (fc <= 0) return null;
    return Math.round((fd / fc) * 100) / 100;
  }

  function formatRate(rate) {
    return rate == null ? '\u2014' : `${rate}x`;
  }

  // Merge a freshly observed user into a record, tracking relationship
  // transitions: f 1→0 records i (I unfollowed them), b 1→0 records u
  // (they unfollowed me); a renewed link clears the matching tombstone.
  // Returns { rec, events: [{ type: 'i_unfollowed'|'unfollowed_me', ts }] }
  function mergeUser(rec, u, now = Date.now()) {
    const next = rec ? { ...rec } : {};
    const events = [];
    const wasMutual = (next.f === 1 || next.f === true) && (next.b === 1 || next.b === true);
    if (u.name) next.n = u.name;
    if (u.avatar) next.a = u.avatar;
    if (typeof u.f === 'boolean' || u.f === 0 || u.f === 1) {
      const f = u.f === 1 || u.f === true;
      if (f) {
        next.f = 1;
        if (next.i) next.i = null; // re-followed — clear tombstone
      } else if (next.f) {
        next.f = 0;
        if (!next.i) { next.i = now; events.push({ type: 'i_unfollowed', ts: now }); }
      } else {
        next.f = 0;
      }
    }
    if (typeof u.b === 'boolean' || u.b === 0 || u.b === 1) {
      const b = u.b === 1 || u.b === true;
      if (b) {
        next.b = 1;
        if (next.u) next.u = null;
      } else if (next.b) {
        next.b = 0;
        if (!next.u) { next.u = now; events.push({ type: 'unfollowed_me', ts: now }); }
      } else {
        next.b = 0;
      }
    }
    if (typeof u.fc === 'number') next.fc = u.fc;
    if (typeof u.fd === 'number') next.fd = u.fd;
    if (typeof u.r === 'number' && Number.isFinite(u.r) && u.r >= 0) next.r = u.r;
    const isMutual = (next.f === 1 || next.f === true) && (next.b === 1 || next.b === true);
    if (wasMutual && !isMutual && !next.m) next.m = now;
    next.t = now;
    return { rec: next, events };
  }

  // Diff two list snapshots and produce unfollow events.
  // prev/next: { following: {handle: ts}, followers: {handle: ts}, ts }
  //   followers lost  → 'unfollowed_me'
  //   following lost  → 'i_unfollowed'
  function diffSnapshots(prev, next) {
    const events = [];
    const now = next?.ts || Date.now();
    const prevB = prev?.followers || {};
    const prevF = prev?.following || {};
    const nextB = next?.followers || {};
    const nextF = next?.following || {};
    for (const h of Object.keys(prevB)) if (!nextB[h]) events.push({ h, type: 'unfollowed_me', ts: now });
    for (const h of Object.keys(prevF)) if (!nextF[h]) events.push({ h, type: 'i_unfollowed', ts: now });
    return events;
  }

  // Deep-extract user objects from a GraphQL payload. Accepts any shape where
  // a node has `legacy.screen_name` + `legacy.followers_count` (timeline
  // items, user_results, core.user_results, direct data.user ...).
  function extractUsers(json) {
    const out = [];
    const seen = new Set();
    const outputByHandle = new Map();
    const visited = new WeakSet();
    // TweetDetail / followers 页面会在 timeline、module、conversation 等多层
    // wrapper 中嵌套 user result。14 层会直接漏掉回复作者；节点预算已经限制
    // 总工作量，因此放宽深度而不牺牲安全边界。
    const MAX_DEPTH = 40;
    const NODE_BUDGET = 200000;
    let budget = NODE_BUDGET;
    function boolField(obj, key) {
      return obj && typeof obj[key] === 'boolean' ? obj[key] : undefined;
    }
    function firstNumber(...values) {
      for (const value of values) {
        const number = typeof value === 'number' ? value : Number(value);
        if (Number.isFinite(number) && number >= 0) return number;
      }
      return undefined;
    }
    function relationshipField(node, legacy, core, key) {
      const aliases = key === 'following'
        ? ['following', 'is_following']
        : ['followed_by', 'followedBy', 'is_followed_by'];
      const candidates = [
        node?.relationship_perspectives,
        node?.relationshipPerspectives,
        node?.relationship,
        node,
        legacy,
        core,
      ];
      for (const candidate of candidates) {
        for (const alias of aliases) {
          const value = boolField(candidate, alias);
          if (value !== undefined) return value;
        }
        const connections = Array.isArray(candidate?.connections) ? candidate.connections : [];
        const normalized = connections.map((value) => String(value).toLowerCase());
        if (normalized.includes(key)) return true;
      }
      return undefined;
    }
    function walk(node, depth) {
      if (node == null || depth > MAX_DEPTH || budget <= 0) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }
      if (typeof node !== 'object') return;
      if (visited.has(node)) return;
      visited.add(node);
      budget--;
      const legacy = node.legacy && typeof node.legacy === 'object' ? node.legacy : {};
      const core = node.core;
      // X 近期的时间线 UserResults 把 screen_name/name 从 legacy 挪到了
      // core，关系字段仍在 result.relationship_perspectives。旧逻辑只认
      // legacy.screen_name，会把整条用户记录跳过，导致时间线没有任何胶囊。
      const screenName = core?.screen_name || legacy?.screen_name || node.screen_name || node.username;
      if (typeof screenName === 'string') {
        const handle = normalizeHandle(screenName);
        if (handle) {
          // X stores the relationship in TWO places: the older legacy.following
          // and the newer relationship_perspectives.following (a sibling of
          // legacy on the same result node). Merge both so we don't miss the
          // flag the timeline actually carries. Only trust explicit booleans
          // — an absent field means "unknown", not "false".
          const rp = node.relationship_perspectives;
          const fFinal = relationshipField(node, legacy, core, 'following');
          const bFinal = relationshipField(node, legacy, core, 'followed_by');
          const user = {
            handle,
            id: typeof node.rest_id === 'string' ? node.rest_id
              : (typeof node.id_str === 'string' ? node.id_str
                : (typeof legacy.id_str === 'string' ? legacy.id_str : undefined)),
            name: core?.name || legacy.name || node.name || '',
            avatar: node?.avatar?.image_url || legacy?.profile_image_url_https || node.profile_image_url_https || '',
            f: typeof fFinal === 'boolean' ? (fFinal ? 1 : 0) : undefined,
            b: typeof bFinal === 'boolean' ? (bFinal ? 1 : 0) : undefined,
            // Some timeline payloads no longer include public counts.  They
            // still include the relationship flags, so do not discard those
            // users just because the optional ratio data is absent.
            fc: firstNumber(
              legacy.followers_count,
              legacy.public_metrics?.followers_count,
              legacy.publicMetrics?.followersCount,
              node.public_metrics?.followers_count,
              node.publicMetrics?.followersCount,
              node.followers_count,
              node.follower_count,
              node.followersCount,
            ),
            fd: firstNumber(
              legacy.friends_count,
              legacy.public_metrics?.following_count,
              legacy.publicMetrics?.followingCount,
              node.public_metrics?.following_count,
              node.publicMetrics?.followingCount,
              node.friends_count,
              node.following_count,
              node.friendsCount,
            ),
          };
          const prior = outputByHandle.get(handle);
          if (prior) {
            for (const key of ['id', 'name', 'f', 'b', 'fc', 'fd']) {
              if (user[key] !== undefined) prior[key] = user[key];
            }
          } else {
            outputByHandle.set(handle, user);
            out.push(user);
          }
        }
      }
      for (const k of Object.keys(node)) walk(node[k], depth + 1);
    }
    walk(json, 0);
    return out;
  }

  // Find the bottom cursor value anywhere in a timeline payload (last wins).
  function findBottomCursor(json) {
    let found = null;
    function walk(node, depth) {
      if (node == null || depth > 12) return;
      if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
      if (typeof node !== 'object') return;
      if (node.cursorType === 'Bottom' && typeof node.value === 'string') found = node.value;
      for (const k of Object.keys(node)) walk(node[k], depth + 1);
    }
    walk(json, 0);
    return found;
  }

  // Locate the timeline entries array in a Following/Followers payload.
  // Known path first, then a generic fallback (any entries[] whose items
  // carry content.itemContent.user_results).
  function findTimelineEntries(json) {
    const known = ['data', 'user', 'result', 'timeline', 'timeline', 'instructions'];
    let node = json;
    for (const part of known) {
      node = node?.[part];
      if (node == null) break;
    }
    if (Array.isArray(node)) {
      const found = node.flatMap((inst) => inst?.entries || []);
      if (found.length) return found;
    }
    let result = null;
    function walk(n, depth) {
      if (result || n == null || depth > 10) return;
      if (Array.isArray(n)) { for (const item of n) walk(item, depth + 1); return; }
      if (typeof n !== 'object') return;
      if (Array.isArray(n.entries) && n.entries.length
        && n.entries.some((e) => e?.content?.itemContent?.user_results)) {
        result = n.entries;
        return;
      }
      for (const k of Object.keys(n)) walk(n[k], depth + 1);
    }
    walk(json, 0);
    return result || [];
  }

  // Bound the user cache: drop the oldest (by lastSeen) entries beyond cap.
  function evictUsers(users, cap = 6000) {
    const keys = Object.keys(users);
    if (keys.length <= cap) return users;
    const sorted = keys
      .map((h) => ({ h, t: users[h].t || 0 }))
      .sort((a, b) => a.t - b.t);
    for (let i = 0; i < sorted.length - cap; i++) delete users[sorted[i].h];
    return users;
  }

  // Parse `{ userId: "123" }` variables JSON, guarded.
  function userIdFromVariables(raw) {
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      const id = v?.userId;
      return typeof id === 'string' && /^\d{1,32}$/.test(id) ? id : null;
    } catch (_) { return null; }
  }

  window.__xvmFollowRadarLogic = {
    normalizeHandle,
    classify,
    computeRate,
    formatRate,
    mergeUser,
    diffSnapshots,
    extractUsers,
    findBottomCursor,
    findTimelineEntries,
    evictUsers,
    userIdFromVariables,
  };
})();
