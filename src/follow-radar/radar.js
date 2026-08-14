// X-Tools 关注雷达 — MAIN-world content script.
//
// Detects the relationship between the logged-in user and the authors shown
// in the velocity leaderboard, and renders a per-row capsule:
//   互关 (mutual) · 我关注 (I follow) · 关注我 (they follow me)
//   · 取关 (previously linked, now gone — red, with a timestamp)
//   · 关注率 (no link → their following ÷ followers ratio, e.g. "3.2x")
//
// Data sources:
//   1. Passive: every GraphQL response the page already loads is scanned for
//      user objects (core/legacy.following|followed_by|counts) via
//      window.__xvmNet — zero extra requests.
//   2. Active: Following / Followers full enumeration (cursor pagination,
//      pacing + 429 backoff, resumable), plus targeted UserByScreenName
//      refreshes for the handles currently visible in the leaderboard.
//
// Persistence goes through bridge.js (ISOLATED world) → chrome.storage.local
// via XVM_FOLLOW_RADAR_LOAD / XVM_FOLLOW_RADAR_SAVE postMessage.

(() => {
  if (window.__xvmFollowRadarReady) return;
  const L = window.__xvmFollowRadarLogic;
  if (!L) {
    console.error('[xvm-fr] follow-radar/logic.js must be loaded before radar.js');
    return;
  }
  window.__xvmFollowRadarReady = true;

  const STORAGE_KEY = 'followRadarV1';
  const EVENTS_MAX = 1000;
  const USERS_CAP = 6000;
  const SCAN_PACING_MS = 900;
  const TARGETED_PACING_MS = 600;
  const RELATIONSHIP_LOOKUP_BATCH = 100;
  const PERSIST_DEBOUNCE_MS = 800;
  const EMIT_DEBOUNCE_MS = 600;
  // X rotates operation ids, so keep a known-good fallback and self-discover
  // the current id from the loaded web bundle when the page has not requested
  // UserByScreenName yet (which is normal on the home timeline).
  const FALLBACK_USER_BY_SCREEN_NAME_TEMPLATE = {
    queryId: 'IGgvgiOx4QZndDHuD3x9TQ',
    authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    features: JSON.stringify({
      hidden_profile_subscriptions_enabled: true,
      profile_label_improvements_pcf_label_in_post_enabled: true,
      responsive_web_profile_redirect_enabled: false,
      rweb_tipjar_consumption_enabled: false,
      verified_phone_label_enabled: false,
      subscriptions_verification_info_is_identity_verified_enabled: true,
      subscriptions_verification_info_verified_since_enabled: true,
      highlights_tweets_tab_ui_enabled: true,
      responsive_web_twitter_article_notes_tab_enabled: true,
      subscriptions_feature_can_gift_premium: true,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
    }),
    fieldToggles: JSON.stringify({ withPayments: false, withAuxiliaryUserLabels: true }),
  };
  const TIMELINE_REFRESH_COOLDOWN_MS = 2500;
  const TIMELINE_REFRESH_BATCH = 30;
  const PROFILE_LOOKUP_COOLDOWN_MS = 5 * 60 * 1000;
  const PROFILE_LOOKUP_RETRY_MS = 15_000;
  // Toggle verbose console logging from the page console:
  //   localStorage.setItem('xvmFrDebug', '1')
  const FR_DEBUG = (() => { try { return localStorage.getItem('xvmFrDebug') === '1'; } catch (_) { return false; } })();
  function dbg(...args) { if (FR_DEBUG) console.log('[xvm-fr]', ...args); }
  function authorizationToken(value) {
    if (!value) return '';
    try { return decodeURIComponent(String(value)); } catch (_) { return String(value); }
  }

  let msgs = {};
  let settings = { enabled: true, timeline: true, leaderboard: true, relations: true, rate: true };
  let state = { users: {}, snap: null, events: [], meta: {} };
  let loaded = false;
  let persistTimer = 0;
  let emitTimer = 0;
  let scanControl = { active: false, kind: null, count: 0, page: 0 };
  let statusText = '';
  let timelineRefreshTimer = 0;
  let timelineRefreshPending = new Set();
  let relationshipLookupPending = new Map();
  let profileLookupPending = new Set();
  let profileLookupAttemptedAt = new Map();
  let profileLookupInFlight = new Set();
  let profileLookupRetryAt = new Map();
  let profileLookupRetryTimer = 0;
  let xPageStore = null;
  let profileTooltipPortal = null;
  let profileTooltipOwner = null;

  // ─── i18n (XVM_SETTINGS_UPDATE broadcast, same as starchart.js) ─────
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.type !== 'XVM_SETTINGS_UPDATE') return;
    if (ev.data.messages) msgs = ev.data.messages;
    if (ev.data.followRadar) {
      settings = { ...settings, ...ev.data.followRadar };
      applyToTimeline();
      scheduleEmit();
    }
  });
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.source !== 'x-tools-library-isolated' || ev.data?.type !== 'XVM_FOLLOW_RADAR_SCAN_COMMAND') return;
    (async () => {
      for (const kind of (Array.isArray(ev.data.kinds) ? ev.data.kinds : ['following', 'followers'])) {
        if (kind === 'following' || kind === 'followers') await scanList(kind);
      }
    })().catch(() => {});
  });
  function tt(key, fallback) { return msgs[key] || fallback; }

  // ─── Storage bridge (bridge.js, ISOLATED world) ─────────────────────
  function loadFromStorage() {
    return new Promise((resolve) => {
      const onMsg = (ev) => {
        if (ev.source !== window || ev.data?.type !== 'XVM_FOLLOW_RADAR_LOADED') return;
        window.removeEventListener('message', onMsg);
        resolve(ev.data.data || null);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'XVM_FOLLOW_RADAR_LOAD' }, '*');
      setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve(null);
      }, 1200);
    });
  }
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      window.postMessage({ type: 'XVM_FOLLOW_RADAR_SAVE', data: state }, '*');
    }, PERSIST_DEBOUNCE_MS);
  }

  // ─── Status events (consumed by content.js footer + pill re-render) ──
  function setStatus(text) { statusText = text; }
  // Snapshot of pills the user can act on this frame — content.js renders the
  // timeline ones from this list and keeps the footer "refresh" target set in sync.
  function snapshotPills() {
    const interactive = [];
    const caps = document.querySelectorAll('[data-xvm-fr-handle]');
    for (const el of caps) {
      const h = el.getAttribute('data-xvm-fr-handle');
      if (!h) continue;
      interactive.push(h);
      const surface = el.getAttribute('data-xvm-fr-surface') || 'timeline';
      const pill = pillFor(h, surface);
      el.style.display = pill ? '' : 'none';
      // Keep the surface marker. Dropping xvm-fr-user-pill here made the next
      // MutationObserver pass believe the profile-card pill was missing and
      // append another capsule every ~600 ms.
      const surfaceClass = surface === 'profile' ? ' xvm-fr-user-pill' : '';
      el.className = `xvm-fr-pill${surfaceClass} ${pill ? pill.cls : 'xvm-fr-rate'}`;
      renderPillContent(el, pill, h);
      el.removeAttribute('title');
    }
    return interactive;
  }
  function emitStatus() {
    const interactive = snapshotPills();
    window.dispatchEvent(new CustomEvent('xvm-fr-updated', {
      detail: { status: statusText, busy: scanControl.active, interactive },
    }));
  }
  function scheduleEmit() {
    clearTimeout(emitTimer);
    emitTimer = setTimeout(emitStatus, EMIT_DEBOUNCE_MS);
  }

  function pushEvent(handle, name, type, ts, rec = state.users[handle]) {
    state.events = state.events || [];
    state.events.push({
      id: `${type}:${handle}:${ts}`,
      h: handle,
      n: name || '',
      type,
      ts,
      fc: Number.isFinite(rec?.fc) ? rec.fc : null,
      fd: Number.isFinite(rec?.fd) ? rec.fd : null,
    });
    if (state.events.length > EVENTS_MAX) state.events = state.events.slice(-EVENTS_MAX);
  }

  // ─── Passive capture ────────────────────────────────────────────────
  function recordUser(u, now = Date.now()) {
    const cur = state.users[u.handle];
    const before = JSON.stringify({ id: cur?.id, f: cur?.f, b: cur?.b, fc: cur?.fc, fd: cur?.fd, r: cur?.r, m: cur?.m });
    const { rec, events } = L.mergeUser(cur, u, now);
    if (u.id) rec.id = String(u.id);
    const after = JSON.stringify({ id: rec.id, f: rec.f, b: rec.b, fc: rec.fc, fd: rec.fd, r: rec.r, m: rec.m });
    if (before === after && !events.length) return false;
    state.users[u.handle] = rec;
    for (const e of events) pushEvent(u.handle, rec.n || u.name, e.type, e.ts, rec);
    return true;
  }

  function ingest(json, url) {
    let changed = false;
    const m = /\/i\/api\/graphql\/([^/]+)\/(Following|Followers|UserByScreenName)(?:\?|$)/.exec(url || '');
    if (m) {
      const [, queryId, op] = m;
      const tpl = state.meta.templates || (state.meta.templates = {});
      const features = (() => {
        try { return new URL(url).searchParams.get('features') || undefined; } catch (_) { return undefined; }
      })();
      if (tpl[op]?.queryId !== queryId || (features && tpl[op]?.features !== features)) {
        tpl[op] = { queryId, ...(features ? { features } : {}) };
        changed = true;
      }
      if (op === 'Following' || op === 'Followers') {
        let userId = null;
        try { userId = L.userIdFromVariables(new URL(url).searchParams.get('variables')); } catch (_) {}
        if (userId && state.meta.myUserId !== userId) {
          state.meta.myUserId = userId;
          changed = true;
        }
      }
    }
    const users = L.extractUsers(json);
    const now = Date.now();
    for (const u of users) {
      if (recordUser(u, now)) changed = true;
    }
    queueRelationshipLookup(users);
    if (users.length) dbg('ingest from', url.slice(0, 80), '→', users.length, 'users, sample:', users.slice(0, 2).map(u => `${u.handle}(f=${u.f},b=${u.b})`).join(', '));
    if (changed) {
      L.evictUsers(state.users, USERS_CAP);
      schedulePersist();
      scheduleEmit();
    }
  }

  function queueRelationshipLookup(users) {
    for (const u of users || []) {
      const h = L.normalizeHandle(u?.handle);
      const id = u?.id || state.users[h]?.id;
      if (h && id && (state.users[h]?.f == null || state.users[h]?.b == null)) {
        relationshipLookupPending.set(h, String(id));
      }
    }
    if (!relationshipLookupPending.size) return;
    const entries = [...relationshipLookupPending.entries()].slice(0, RELATIONSHIP_LOOKUP_BATCH);
    entries.forEach(([h]) => relationshipLookupPending.delete(h));
    lookupRelationships(entries).catch(() => {});
  }

  async function lookupRelationships(entries) {
    // On a cold home-timeline load no X API request may have exposed a bearer
    // token to the net hook yet.  Use the same known-good fallback as the
    // UserByScreenName request instead of silently abandoning the lookup.
    const auth = authorizationToken(window.__xvmNet?.getBearer?.() || FALLBACK_USER_BY_SCREEN_NAME_TEMPLATE.authorization);
    if (!auth || !entries.length) return;
    const url = new URL('/i/api/1.1/friendships/lookup.json', location.origin);
    url.searchParams.set('user_id', entries.map(([, id]) => id).join(','));
    const res = await fetch(url.toString(), {
      credentials: 'include',
      headers: {
        authorization: auth,
        'x-csrf-token': getCsrf(),
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
      },
    });
    if (!res.ok) return;
    const rows = await res.json();
    for (const row of Array.isArray(rows) ? rows : []) {
      const h = L.normalizeHandle(row?.screen_name);
      if (!h) continue;
      const connections = Array.isArray(row.connections) ? row.connections : [];
      const normalizedConnections = connections.map((c) => String(c).toLowerCase());
      recordUser({ handle: h, f: normalizedConnections.includes('following') ? 1 : 0, b: normalizedConnections.includes('followed_by') ? 1 : 0 });
    }
    if (relationshipLookupPending.size) {
      const next = [...relationshipLookupPending.entries()].slice(0, RELATIONSHIP_LOOKUP_BATCH);
      next.forEach(([h]) => relationshipLookupPending.delete(h));
      lookupRelationships(next).catch(() => {});
    }
    schedulePersist();
    scheduleEmit();
  }

  function findXPageStore() {
    if (xPageStore?.getState) return xPageStore;
    const hosts = document.querySelectorAll(
      'article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="cellInnerDiv"]',
    );
    for (const host of hosts) {
      const fiberKey = Object.getOwnPropertyNames(host)
        .find((key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
      let fiber = fiberKey ? host[fiberKey] : null;
      for (let depth = 0; fiber && depth < 60; depth += 1, fiber = fiber.return) {
        const props = [fiber.memoizedProps, fiber.pendingProps];
        for (const candidate of props) {
          const store = candidate?.value?.store || candidate?.store || candidate?.context?.store;
          if (store?.getState) {
            xPageStore = store;
            return xPageStore;
          }
        }
        if (fiber.stateNode?.store?.getState) {
          xPageStore = fiber.stateNode.store;
          return xPageStore;
        }
      }
    }
    return null;
  }

  function pageStateHandle(node) {
    return L.normalizeHandle(
      node?.core?.screen_name
      || node?.legacy?.screen_name
      || node?.screen_name
      || node?.username,
    );
  }

  function lookupProfilesFromPageStore(handles) {
    const targets = new Set((handles || []).map((handle) => L.normalizeHandle(handle)).filter(Boolean));
    const resolved = new Set();
    if (!targets.size) return resolved;
    const store = findXPageStore();
    if (!store) return resolved;
    let root;
    try { root = store.getState(); } catch (_) { return resolved; }
    if (!root || typeof root !== 'object') return resolved;

    // X 的 Redux 树较大，只做有目标的有限深度遍历。找到完整资料后立即停止，
    // 避免依赖易变的 webpack 模块编号，也不会触发任何额外网络请求。
    const stack = [root];
    const visited = new WeakSet();
    let budget = 60000;
    let changed = false;
    while (stack.length && budget-- > 0 && resolved.size < targets.size) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || visited.has(node)) continue;
      visited.add(node);
      const handle = pageStateHandle(node);
      if (handle && targets.has(handle)) {
        if (ingestProfileRow(node, handle)) changed = true;
        if (hasProfileCount(state.users[handle]?.fc)
          && hasProfileCount(state.users[handle]?.fd)) resolved.add(handle);
      }
      if (Array.isArray(node)) {
        for (let index = node.length - 1; index >= 0; index -= 1) stack.push(node[index]);
      } else {
        for (const value of Object.values(node)) {
          if (value && typeof value === 'object') stack.push(value);
        }
      }
    }
    queueRelationshipLookup([...targets].map((handle) => ({
      handle,
      id: state.users[handle]?.id,
    })));
    if (changed) {
      schedulePersist();
      scheduleEmit();
    }
    return resolved;
  }

  async function lookupProfileCounts(handles) {
    const wanted = [...new Set((handles || []).map((handle) => L.normalizeHandle(handle)).filter(Boolean))]
      .slice(0, TIMELINE_REFRESH_BATCH);
    const resolved = lookupProfilesFromPageStore(wanted);
    const requested = wanted.filter((handle) => !resolved.has(handle));
    const auth = authorizationToken(window.__xvmNet?.getBearer?.() || FALLBACK_USER_BY_SCREEN_NAME_TEMPLATE.authorization);
    if (!auth || !requested.length) return resolved;

    // X 的 v1.1 users/lookup 可一次返回多位用户的粉丝数、关注数与关系字段。
    // 相比逐个 users/show 请求，它更稳定，也避免虚拟列表反复挂载时形成请求风暴。
    try {
      const url = new URL('/i/api/1.1/users/lookup.json', location.origin);
      url.searchParams.set('screen_name', requested.join(','));
      const res = await fetch(url.toString(), { credentials: 'include', headers: {
        authorization: auth, 'x-csrf-token': getCsrf(),
        'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session',
      } });
      if (res.status === 429) throw profileRateLimitError(res);
      if (res.ok) {
        const rows = await res.json();
        for (const row of Array.isArray(rows) ? rows : []) {
          const handle = L.normalizeHandle(row?.screen_name);
          if (!handle) continue;
          ingestProfileRow(row, handle);
          if (profileRowHasCounts(row)) resolved.add(handle);
        }
      }
    } catch (err) {
      // 批量接口已经明确限频时必须立即停止。旧逻辑继续逐个调用
      // users/show + UserByScreenName，会把一页回复瞬间放大成几十次请求。
      if (err?.code === 429) throw err;
    }

    // users/lookup 在部分账号只返回关系字段，不能把这种响应当作计数已完成。
    // 逐个 users/show 是更轻量的第二层兜底，成功后才进入资料查询冷却。
    for (const handle of requested.filter((item) => !resolved.has(item))) {
      try {
        const url = new URL('/i/api/1.1/users/show.json', location.origin);
        url.searchParams.set('screen_name', handle);
        const res = await fetch(url.toString(), { credentials: 'include', headers: {
          authorization: auth, 'x-csrf-token': getCsrf(),
          'x-twitter-active-user': 'yes', 'x-twitter-auth-type': 'OAuth2Session',
        } });
        if (res.status === 429) throw profileRateLimitError(res);
        if (res.ok) {
          const row = await res.json();
          ingestProfileRow(row, handle);
          if (profileRowHasCounts(row)) resolved.add(handle);
        }
      } catch (err) {
        if (err?.code === 429) throw err;
      }
      await sleep(80);
    }

    // 部分账号可能被批量接口过滤（受限账号等），再以 GraphQL 单用户查询兜底。
    const template = radarTemplate('UserByScreenName');
    for (const handle of requested.filter((item) => !resolved.has(item))) {
      try {
        if (!template?.queryId || template.queryId === 'REPLACE_AT_RUNTIME') continue;
        const json = await callGraphQL('UserByScreenName', {
          screen_name: handle,
        }, template.features);
        ingestProfileRow(json, handle);
        if (profileRowHasCounts(json)) resolved.add(handle);
      } catch (err) {
        if (err?.code === 429) throw err;
      }
      await sleep(120);
    }
    schedulePersist();
    scheduleEmit();
    return resolved;
  }

  function subscribe() {
    const net = window.__xvmNet;
    if (net?.onResponse) {
      dbg('subscribing via __xvmNet');
      // X's operation names and URLs are case-sensitive but the path may
      // contain /graphql or /GraphQL across builds. Keep the matcher tolerant
      // so the initial HomeTimeline payload (which already contains user
      // public counts) is never skipped before the active fallback runs.
      net.onResponse(/graphql/i, async ({ url, response, source }) => {
        try {
          const json = source === 'fetch' ? await response.clone().json() : await response.json();
          ingest(json, url);
        } catch (_) {}
      });
    } else {
      // Fallback: if __xvmNet isn't ready (load-order race), hook fetch and
      // subscribe again as soon as the shared net hook appears. The old
      // one-shot behaviour permanently missed XHR GraphQL traffic whenever
      // radar.js happened to execute before x-net-hook.js was ready.
      dbg('__xvmNet unavailable — installing own fetch hook');
      const origFetch = window.fetch;
      window.fetch = async function (...args) {
        const res = await origFetch.apply(this, args);
        try {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
          if (/graphql/i.test(url)) {
            const clone = res.clone();
            clone.json().then((json) => ingest(json, url)).catch(() => {});
          }
        } catch (_) {}
        return res;
      };
      let retries = 0;
      const subscribeRetry = setInterval(() => {
        retries++;
        if (window.__xvmNet?.onResponse) {
          clearInterval(subscribeRetry);
          window.__xvmNet.onResponse(/graphql/i, async ({ url, response, source }) => {
            try {
              const json = source === 'fetch' ? await response.clone().json() : await response.json();
              ingest(json, url);
            } catch (_) {}
          });
        } else if (retries >= 20) clearInterval(subscribeRetry);
      }, 100);
    }
  }

  // ─── DOM bridge for timeline tweets ─────────────────────────────────
  // X's DOM already shows the "Follows you" badge for followers; for the
  // other directions X never renders anything on the timeline, so we rely on
  // passive capture / active scan. Reading the badge here keeps "关注我"
  // accurate without an extra request.
  function absorbFromCell(cell, article = null) {
    if (!cell) return null;
    // A virtualised cellInnerDiv can contain more than one tweet.  Prefer the
    // current article, otherwise the first author's handle can be assigned to
    // every tweet in that cell and its capsule will never match the relation.
    const scope = article?.querySelector?.('[data-testid="User-Name"]') ? article : cell;
    // Reuse the same proven approach as content.js getAuthorInfo: scan spans
    // inside [data-testid="User-Name"] for one starting with "@".
    const nameBlock = scope.querySelector('[data-testid="User-Name"]');
    let handle = null;
    if (nameBlock) {
      const spans = nameBlock.querySelectorAll('span');
      for (const s of spans) {
        const t = (s.textContent || '').trim();
        if (t.startsWith('@')) { handle = t.slice(1).toLowerCase(); break; }
      }
      if (!handle) {
        const link = nameBlock.querySelector('a[role="link"][href^="/"]');
        const m = (link?.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$|\?)/);
        if (m) handle = m[1].toLowerCase();
      }
    }
    // Fallback: href on the profile link.
    if (!handle) {
      const link = scope.querySelector('a[role="link"][href^="/"]');
      if (link) {
        const m = (link.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$|\?)/);
        if (m) handle = m[1].toLowerCase();
      }
    }
    if (!handle || !/^[a-z0-9_]{1,15}$/.test(handle)) return null;
    const cellText = scope.textContent || '';
    const followsYou = /follows you|关注了你|正在关注你|フォローされています|Đang theo dõi bạn|회원님을 팔로우합니다/.test(cellText);
    const u = { handle };
    if (followsYou) u.b = 1;
    if (recordUser(u)) { schedulePersist(); }
    return handle;
  }

  function absorbUserCardRelation(card, handle) {
    const text = card.textContent || '';
    const buttonText = [...card.querySelectorAll('button')].map((button) => (button.textContent || '').trim()).join(' ');
    const u = { handle };
    if (/关注了你|follows you|フォローされています|Đang theo dõi bạn/i.test(text)) u.b = 1;
    if (/正在关注|following/i.test(buttonText)) u.f = 1;
    else if (/回关|关注|follow/i.test(buttonText) && !/正在关注|following/i.test(buttonText)) u.f = 0;
    if (u.f !== undefined || u.b !== undefined) recordUser(u);
    absorbVisibleRate(card, handle);
  }

  // Interoperate with any already-rendered public ratio badge. This is only a
  // fallback while X's profile query is pending; native GraphQL counts remain
  // the primary source. It also makes hot reloads immediately reuse a value
  // already visible in the same user/tweet row instead of showing a dash.
  function absorbVisibleRate(scope, handle) {
    for (const node of scope.querySelectorAll('span,div')) {
      if (node.classList?.contains('xvm-fr-pill') || node.children.length > 3) continue;
      const text = (node.textContent || '').trim();
      const match = text.match(/^(?:互关|我关注|关注我|关注率)\s+(\d+(?:\.\d+)?)$/);
      if (!match) continue;
      const rate = Number(match[1]);
      if (Number.isFinite(rate) && recordUser({ handle, r: rate })) schedulePersist();
      return rate;
    }
    return null;
  }

  // Inject / refresh a pill next to the username row of a tweet (mirrors the
  // x互关雷达 placement the user wants). We inject into the User-Name row.
  function ensureTimelinePill(article, handle) {
    const caret = [...article.querySelectorAll('[data-testid="caret"], button[aria-label*="More"], button[aria-label*="更多"], button[title*="More"], button[title*="更多"]')]
      .find((node) => node.closest('article[data-testid="tweet"]') === article);
    const nameRow = article.querySelector('[data-testid="User-Name"]');
    let host = null;
    if (caret && nameRow) {
      let node = caret.parentElement;
      while (node && node !== article) {
        const style = getComputedStyle(node);
        if (style.display === 'flex' && style.flexDirection === 'row'
          && node.contains(nameRow) && node.contains(caret)) {
          host = node;
          break;
        }
        node = node.parentElement;
      }
    }
    host ||= caret?.parentElement || nameRow;
    if (!host) return false;
    let pill = article.querySelector('.xvm-fr-pill');
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'xvm-fr-pill';
    }
    // Move an existing pill too; this matters after hot reloads where an old
    // version may have inserted it beside the username row. If X is still
    // mounting the caret, leave an existing pill where it is until the next
    // pass instead of moving it back to the username row.
    let anchor = caret;
    while (anchor?.parentElement && anchor.parentElement !== host) anchor = anchor.parentElement;
    if (caret && anchor?.parentElement === host && (pill.parentElement !== host || anchor.nextElementSibling !== pill)) host.insertBefore(pill, anchor.nextSibling);
    else if (!pill.parentElement) host.appendChild(pill);
    pill.setAttribute('data-xvm-fr-handle', handle);
    pill.setAttribute('data-xvm-fr-surface', 'timeline');
    const data = pillFor(handle, 'timeline');
    if (!data) {
      pill.style.display = 'none';
      renderPillContent(pill, null, handle);
      return false;
    }
    pill.style.display = '';
    pill.className = `xvm-fr-pill ${data.cls}`;
    renderPillContent(pill, data, handle);
    pill.removeAttribute('title');
    return true;
  }

  function applyToTimeline() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    if (!settings.enabled || !settings.timeline) {
      document.querySelectorAll('article[data-testid="tweet"] .xvm-fr-pill').forEach((pill) => { pill.style.display = 'none'; });
      return;
    }
    let anyShown = false;
    let withData = 0;
    const visibleHandles = [];
    for (const article of articles) {
      if (article.closest('.xvm-lb')) continue; // skip leaderboard rows
      const cell = article.closest('[data-testid="cellInnerDiv"]') || article;
      const handle = absorbFromCell(cell, article);
      if (!handle) continue;
      absorbVisibleRate(article, handle);
      visibleHandles.push(handle);
      if (ensureTimelinePill(article, handle)) { anyShown = true; withData++; }
    }
    scheduleTimelineRefresh(visibleHandles);
    queueProfileLookup(visibleHandles);
    if (articles.length) dbg('applyToTimeline:', articles.length, 'articles,', withData, 'with pill data,', Object.keys(state.users).length, 'users cached');
    return anyShown;
  }

  // ─── User cards on profile/followers/following/search pages ─────────
  function userCardHandle(card) {
    const nameBlock = card.querySelector('[data-testid="User-Name"]');
    if (nameBlock) {
      for (const span of nameBlock.querySelectorAll('span')) {
        const text = (span.textContent || '').trim();
        if (text.startsWith('@')) return L.normalizeHandle(text);
      }
      const link = nameBlock.querySelector('a[role="link"][href^="/"]');
      const match = (link?.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$|\?)/);
      if (match) return L.normalizeHandle(match[1]);
    }
    // UserCell cards in the current X build omit User-Name entirely. Their
    // profile links are repeated for avatar/name; use an exact /handle href
    // and exclude reserved application routes.
    const reserved = new Set(['home', 'explore', 'notifications', 'messages', 'i', 'settings', 'compose']);
    for (const link of card.querySelectorAll('a[role="link"][href^="/"]')) {
      const match = (link.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})$/);
      const handle = match && L.normalizeHandle(match[1]);
      if (handle && !reserved.has(handle)) return handle;
    }
    return null;
  }

  function ensureUserCardPill(card, handle) {
    const owner = card.closest('[data-testid="UserCell"]') || card;
    const actionButton = [...owner.querySelectorAll('button')].find((button) => /^(回关|正在关注|关注|Follow|Following|关注了你)/i.test((button.textContent || '').trim()));
    const existingPills = [...owner.querySelectorAll('.xvm-fr-user-pill')];
    const pill = existingPills[0] || document.createElement('span');
    existingPills.slice(1).forEach((extra) => extra.remove());
    pill.className = 'xvm-fr-pill xvm-fr-user-pill';
    // 胶囊绝对定位到原生操作按钮左侧，不参与 X 的 flex/column 布局，
    // 因而不会再把“回关 / 正在关注”顶到下一行或与其重叠。
    if (pill.parentElement !== owner) owner.appendChild(pill);
    pill.setAttribute('data-xvm-fr-handle', handle);
    pill.setAttribute('data-xvm-fr-surface', 'profile');
    const data = pillFor(handle, 'profile');
    pill.style.display = '';
    pill.className = `xvm-fr-pill xvm-fr-user-pill ${data?.cls || 'xvm-fr-rate'}`;
    renderPillContent(pill, data || { label: `${tt('frRate', '关注率')} \u2014` }, handle);
    pill.removeAttribute('title');
    if (actionButton) positionUserCardPill(owner, actionButton, pill);
    return true;
  }

  function positionUserCardPill(owner, actionButton, pill) {
    owner.classList.add('xvm-fr-user-card-owner');
    const ownerBox = owner.getBoundingClientRect();
    const buttonBox = actionButton.getBoundingClientRect();
    const pillBox = pill.getBoundingClientRect();
    const width = pillBox.width || pill.offsetWidth || 102;
    const height = pillBox.height || pill.offsetHeight || 30;
    let left = buttonBox.left - ownerBox.left - width - 8;
    if (left < 4) left = Math.min(ownerBox.width - width - 4, buttonBox.right - ownerBox.left + 8);
    pill.style.left = `${Math.max(4, left)}px`;
    pill.style.top = `${Math.max(0, buttonBox.top - ownerBox.top + (buttonBox.height - height) / 2)}px`;
  }

  function applyToUserCards() {
    if (!settings.enabled) return false;
    const markedCards = [...document.querySelectorAll('[data-testid="UserCell"]')];
    const cards = markedCards.length
      ? markedCards
      : [...document.querySelectorAll('li[role="listitem"]')].filter((card) => card.querySelector('a[role="link"][href^="/"]')
        && !card.parentElement?.closest('li[role="listitem"]'));
    const handles = [];
    let shown = 0;
    for (const card of cards) {
      if (card.closest('article[data-testid="tweet"]')) continue;
      const handle = userCardHandle(card);
      if (!handle) continue;
      handles.push(handle);
      absorbUserCardRelation(card, handle);
      if (ensureUserCardPill(card, handle)) shown++;
    }
    scheduleTimelineRefresh(handles);
    queueProfileLookup(handles);
    if (cards.length) dbg('applyToUserCards:', cards.length, 'cards,', shown, 'with pills');
    return shown > 0;
  }

  function queueProfileLookup(handles) {
    const now = Date.now();
    const normalized = [...new Set((handles || []).map((handle) => L.normalizeHandle(handle)).filter(Boolean))];
    // React 挂载与 DOM MutationObserver 可能相差一个渲染帧。每次可见列表
    // 复扫时先读页面 Store，即使上一轮网络请求已被 429 延后，也能马上补数。
    lookupProfilesFromPageStore(normalized);
    for (const handle of normalized) {
      const h = L.normalizeHandle(handle);
      if (!h) continue;
      const rec = state.users[h];
      const lastAttempt = profileLookupAttemptedAt.get(h) || 0;
      if (profileRecordNeedsRefresh(rec)
        && !profileLookupInFlight.has(h)
        && now >= (profileLookupRetryAt.get(h) || 0)
        && now - lastAttempt >= PROFILE_LOOKUP_COOLDOWN_MS) profileLookupPending.add(h);
    }
    if (!profileLookupPending.size) return;
    const batch = [...profileLookupPending].slice(0, TIMELINE_REFRESH_BATCH);
    batch.forEach((handle) => {
      profileLookupPending.delete(handle);
      profileLookupInFlight.add(handle);
    });
    lookupProfileCounts(batch).then((resolved = new Set()) => {
      const completedAt = Date.now();
      for (const handle of batch) {
        if (resolved.has(handle)) {
          profileLookupAttemptedAt.set(handle, completedAt);
          profileLookupRetryAt.delete(handle);
        } else {
          // 资料不完整也要定时重试，不能依赖页面恰好再发生一次 DOM 变化。
          profileLookupRetryAt.set(handle, completedAt + PROFILE_LOOKUP_RETRY_MS);
        }
      }
      armProfileLookupRetry();
    }).catch((err) => {
      const retryAt = Date.now() + Math.max(PROFILE_LOOKUP_RETRY_MS, Number(err?.waitMs) || 0);
      batch.forEach((handle) => profileLookupRetryAt.set(handle, retryAt));
      armProfileLookupRetry();
    }).finally(() => {
      batch.forEach((handle) => profileLookupInFlight.delete(handle));
      // 一页超过批量上限时继续消费余下句柄；过去只处理首批 30 个。
      if (profileLookupPending.size) queueMicrotask(() => queueProfileLookup([...profileLookupPending]));
    });
  }

  function profileRecordNeedsRefresh(rec) {
    return !rec
      || !hasProfileCount(rec.fc)
      || !hasProfileCount(rec.fd);
  }

  function hasProfileCount(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  }

  function profileRateLimitError(response) {
    const reset = parseInt(response?.headers?.get?.('x-rate-limit-reset') || '0', 10);
    const waitMs = reset * 1000 > Date.now()
      ? reset * 1000 - Date.now()
      : PROFILE_LOOKUP_RETRY_MS;
    const err = new Error('profile-rate-limited');
    err.code = 429;
    err.waitMs = waitMs;
    return err;
  }

  function armProfileLookupRetry() {
    clearTimeout(profileLookupRetryTimer);
    const now = Date.now();
    const waiting = [...profileLookupRetryAt.entries()]
      .filter(([handle]) => profileRecordNeedsRefresh(state.users[handle]));
    if (!waiting.length) {
      profileLookupRetryTimer = 0;
      return;
    }
    const nextAt = Math.min(...waiting.map(([, retryAt]) => retryAt));
    profileLookupRetryTimer = setTimeout(() => {
      profileLookupRetryTimer = 0;
      const readyAt = Date.now();
      const ready = [...profileLookupRetryAt.entries()]
        .filter(([handle, retryAt]) => retryAt <= readyAt && profileRecordNeedsRefresh(state.users[handle]))
        .map(([handle]) => handle);
      queueProfileLookup(ready);
      if (!ready.length) armProfileLookupRetry();
    }, Math.max(0, nextAt - now) + 20);
  }

  function ingestProfileRow(row, fallbackHandle = '') {
    if (!row || typeof row !== 'object') return false;
    const result = row?.data?.user?.result || row?.data?.user_result_by_screen_name?.result || row?.result || row;
    const legacy = result?.legacy || row?.legacy || row;
    const core = result?.core || row?.core || {};
    const handle = L.normalizeHandle(core?.screen_name || legacy?.screen_name || row?.screen_name || row?.username || fallbackHandle);
    if (!handle) return false;
    const fcRaw = legacy?.followers_count ?? result?.public_metrics?.followers_count
      ?? result?.publicMetrics?.followersCount ?? row?.followers_count ?? row?.follower_count ?? row?.followersCount;
    const fdRaw = legacy?.friends_count ?? result?.public_metrics?.following_count
      ?? result?.publicMetrics?.followingCount ?? row?.friends_count ?? row?.following_count ?? row?.friendsCount;
    const connections = Array.isArray(row?.connections) ? row.connections.map((item) => String(item).toLowerCase()) : [];
    const f = result?.relationship_perspectives?.following ?? legacy?.following ?? row?.following
      ?? row?.is_following ?? (connections.length ? connections.includes('following') : undefined);
    const b = result?.relationship_perspectives?.followed_by ?? legacy?.followed_by ?? row?.followed_by
      ?? row?.is_followed_by ?? (connections.length ? connections.includes('followed_by') : undefined);
    return recordUser({
      handle,
      id: result?.rest_id || legacy?.id_str || row?.id_str || row?.id,
      name: core?.name || legacy?.name || row?.name,
      avatar: result?.avatar?.image_url || legacy?.profile_image_url_https || row?.profile_image_url_https,
      fc: hasProfileCount(fcRaw) ? Number(fcRaw) : undefined,
      fd: hasProfileCount(fdRaw) ? Number(fdRaw) : undefined,
      f: typeof f === 'boolean' ? (f ? 1 : 0) : undefined,
      b: typeof b === 'boolean' ? (b ? 1 : 0) : undefined,
    });
  }

  function profileRowHasCounts(row) {
    if (!row || typeof row !== 'object') return false;
    const result = row?.data?.user?.result || row?.data?.user_result_by_screen_name?.result || row?.result || row;
    const legacy = result?.legacy || row?.legacy || row;
    const fc = legacy?.followers_count ?? result?.public_metrics?.followers_count
      ?? result?.publicMetrics?.followersCount ?? row?.followers_count ?? row?.follower_count ?? row?.followersCount;
    const fd = legacy?.friends_count ?? result?.public_metrics?.following_count
      ?? result?.publicMetrics?.followingCount ?? row?.friends_count ?? row?.following_count ?? row?.friendsCount;
    return hasProfileCount(fc) && hasProfileCount(fd);
  }

  // ─── Active GraphQL calls ───────────────────────────────────────────
  function radarTemplate(op) {
    const stored = state.meta.templates?.[op];
    if (stored?.queryId && stored.queryId !== 'REPLACE_AT_RUNTIME') return stored;
    const chart = window.__XVMStarChart?._internal?.getTemplate?.(op);
    if (chart?.queryId && chart.queryId !== 'REPLACE_AT_RUNTIME') return chart;
    return op === 'UserByScreenName' ? FALLBACK_USER_BY_SCREEN_NAME_TEMPLATE : null;
  }

  function discoverUserByScreenNameTemplate(force = false) {
    if (!force && state.meta.templates?.UserByScreenName?.queryId) return;
    const urls = [...new Set([
      ...Array.from(document.scripts || []).map((s) => s.src),
      ...performance.getEntriesByType('resource').map((e) => e.name),
    ].filter((u) => /abs\.twimg\.com\/responsive-web\/client-web\/.*\.js/.test(u)))];
    if (!urls.length) return;
    Promise.all(urls.slice(0, 60).map(async (url) => {
      try {
        const text = await fetch(url, { credentials: 'omit' }).then((r) => r.ok ? r.text() : '');
        const marker = text.search(/operationName[:=]["']UserByScreenName["']/);
        if (marker < 0) return null;
        const part = text.slice(Math.max(0, marker - 5000), marker + 500);
        const queryId = part.match(/queryId[:=]["']([A-Za-z0-9_-]{15,30})["']/)?.[1]
          || text.slice(marker).match(/queryId[:=]["']([A-Za-z0-9_-]{15,30})["']/)?.[1];
        return queryId ? { queryId } : null;
      } catch (_) { return null; }
    })).then((found) => {
      const template = found.find(Boolean);
      if (!template || (!force && state.meta.templates?.UserByScreenName?.queryId)) return;
      state.meta.templates = { ...(state.meta.templates || {}), UserByScreenName: {
        ...FALLBACK_USER_BY_SCREEN_NAME_TEMPLATE, ...template,
      } };
      schedulePersist();
    }).catch(() => {});
  }

  function scheduleTimelineRefresh(handles) {
    if (!settings.enabled) return;
    for (const h of handles || []) {
      const rec = state.users[L.normalizeHandle(h)];
      if (profileRecordNeedsRefresh(rec)) {
        timelineRefreshPending.add(h);
      }
    }
    if (!timelineRefreshPending.size || timelineRefreshTimer) return;
    timelineRefreshTimer = setTimeout(() => {
      timelineRefreshTimer = 0;
      const batch = [...timelineRefreshPending]
        .filter((handle) => profileRecordNeedsRefresh(state.users[L.normalizeHandle(handle)]))
        .slice(0, TIMELINE_REFRESH_BATCH);
      if (scanControl.active) {
        scheduleTimelineRefresh([]);
        return;
      }
      batch.forEach((h) => timelineRefreshPending.delete(h));
      // 自动补数统一走批量队列。逐个 UserByScreenName 仅保留给用户显式
      // 点击“刷新关系”，避免帖子详情的一页回复把限频配额打满。
      queueProfileLookup(batch);
      if (timelineRefreshPending.size) scheduleTimelineRefresh([]);
    }, TIMELINE_REFRESH_COOLDOWN_MS);
  }
  function getCsrf() {
    const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }
  async function callGraphQL(op, variables, features) {
    const tpl = radarTemplate(op);
    if (!tpl) throw new Error(`no-template:${op}`);
    if (!tpl.queryId || tpl.queryId === 'REPLACE_AT_RUNTIME') throw new Error(`no-queryid:${op}`);
    const auth = authorizationToken(window.__xvmNet?.getBearer?.() || tpl.authorization || '');
    if (!auth) throw new Error('no-auth');
    const url = new URL(`/i/api/graphql/${tpl.queryId}/${op}`, location.origin);
    url.searchParams.set('variables', JSON.stringify(variables));
    if (features) url.searchParams.set('features', features);
    if (tpl.fieldToggles) url.searchParams.set('fieldToggles', tpl.fieldToggles);
    const res = await fetch(url.toString(), {
      credentials: 'include',
      headers: {
        authorization: auth,
        'x-csrf-token': getCsrf(),
        'content-type': 'application/json',
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
      },
    });
    if (res.status === 429) {
      const reset = parseInt(res.headers.get('x-rate-limit-reset') || '0', 10);
      const waitMs = reset * 1000 > Date.now() ? reset * 1000 - Date.now() : 60000;
      const err = new Error('rate-limited');
      err.code = 429;
      err.waitMs = waitMs;
      throw err;
    }
    if (!res.ok) {
      // X 会不定期轮换 GraphQL query id。失效模板不能继续留在缓存中，
      // 否则资料计数会永久显示“查询中”，直到用户手动清除扩展数据。
      if (op === 'UserByScreenName' && [400, 404].includes(res.status)) {
        const stored = state.meta.templates?.UserByScreenName;
        if (stored?.queryId === tpl.queryId) {
          state.meta.templates = { ...(state.meta.templates || {}) };
          delete state.meta.templates.UserByScreenName;
          schedulePersist();
        }
        discoverUserByScreenNameTemplate(true);
      }
      throw new Error(`HTTP ${res.status} on ${op}`);
    }
    return res.json();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ─── Scan: full Following / Followers enumeration ───────────────────
  async function scanList(kind) {
    if (scanControl.active) return false;
    const op = kind === 'following' ? 'Following' : 'Followers';
    const userId = state.meta.myUserId;
    if (!userId) {
      setStatus(tt('frNeedUserId', '请先打开一次自己的主页'));
      emitStatus();
      return false;
    }
    const tpl = radarTemplate(op);
    if (!tpl?.queryId || tpl.queryId === 'REPLACE_AT_RUNTIME') {
      setStatus(tt('frNeedTemplate', '先访问一次关注/粉丝页以初始化'));
      emitStatus();
      return false;
    }
    scanControl = { active: true, kind, count: 0, page: 0 };
    emitStatus();
    try {
      const collected = {};
      const now = Date.now();
      let cursor = state.meta.cursor?.[kind] || null;
      let attempts = 0;
      for (;;) {
        if (!scanControl.active) break;
        let json;
        try {
          json = await callGraphQL(op, { userId, count: 100, cursor }, tpl.features);
          attempts = 0;
        } catch (err) {
          if (err?.code === 429 && attempts < 5) {
            attempts++;
            setStatus(tt('frRateLimited', '限频，等待 {{SECONDS}} 秒后继续')
              .replace('{{SECONDS}}', String(Math.ceil(err.waitMs / 1000))));
            emitStatus();
            await sleep(err.waitMs);
            continue;
          }
          throw err;
        }
        const entries = L.findTimelineEntries(json);
        for (const e of entries) {
          const parsed = L.extractUsers(e?.content?.itemContent?.user_results || {});
          for (const u of parsed) {
            // Authoritative relationship comes from the list itself.
            if (kind === 'following') u.f = 1; else u.b = 1;
            if (recordUser(u, now)) scanControl.count++;
            collected[u.handle] = now;
          }
        }
        cursor = L.findBottomCursor(json);
        state.meta.cursor = { ...(state.meta.cursor || {}), [kind]: cursor };
        scanControl.page++;
        setStatus(tt('frScanBusy', '扫描中 {{COUNT}}')
          .replace('{{COUNT}}', String(scanControl.count)));
        schedulePersist();
        scheduleEmit();
        if (!cursor) break;
        await sleep(SCAN_PACING_MS);
      }
      // Snapshot + diff → unfollow events.
      const snap = state.snap ? { ...state.snap } : { following: {}, followers: {}, ts: 0 };
      if (kind === 'following') snap.following = collected;
      else snap.followers = collected;
      snap.ts = Date.now();
      const evts = L.diffSnapshots(state.snap, snap);
      state.snap = snap;
      for (const e of evts) {
        const rec = state.users[e.h];
        if (rec) {
          const wasMutual = Boolean(rec.f && rec.b);
          if (e.type === 'unfollowed_me') { rec.u = e.ts; rec.b = 0; } else { rec.i = e.ts; rec.f = 0; }
          if (wasMutual && !rec.m) rec.m = e.ts;
          rec.t = e.ts;
        } else {
          state.users[e.h] = { n: '', f: 0, b: 0, t: e.ts, [e.type === 'unfollowed_me' ? 'u' : 'i']: e.ts };
        }
        pushEvent(e.h, state.users[e.h]?.n || '', e.type, e.ts, state.users[e.h]);
      }
      if (state.meta.cursor) delete state.meta.cursor[kind];
      setStatus(tt('frScanDone', '完成 · 共 {{COUNT}}')
        .replace('{{COUNT}}', String(Object.keys(collected).length)));
      schedulePersist();
    } catch (err) {
      console.error('[xvm-fr] scan failed', err);
      setStatus(err?.code === 429 ? tt('frRateLimited', '限频，等待 {{SECONDS}} 秒后继续')
        .replace('{{SECONDS}}', String(Math.ceil(err.waitMs / 1000)))
        : tt('frScanError', '扫描失败，请重试'));
    } finally {
      scanControl.active = false;
      schedulePersist();
      scheduleTimelineRefresh([]);
      emitStatus();
    }
    return true;
  }

  // ─── Targeted refresh: re-check visible leaderboard handles ─────────
  async function refreshHandles(handles, options = {}) {
    const hList = [...new Set((handles || [])
      .map((h) => L.normalizeHandle(h))
      .filter(Boolean))].slice(0, 30);
    if (!hList.length) return;
    if (scanControl.active) return;
    const tpl = radarTemplate('UserByScreenName');
    if (!tpl?.queryId || tpl.queryId === 'REPLACE_AT_RUNTIME') return;
    scanControl = { active: true, kind: 'targeted', count: 0, page: 0 };
    emitStatus();
    try {
      for (const h of hList) {
        if (!scanControl.active) break;
        try {
          const json = await callGraphQL('UserByScreenName', {
            screen_name: h,
          }, tpl.features);
          ingest(json, '');
          scanControl.count++;
        } catch (err) { dbg('refresh failed', h, String(err?.message || err)); }
        await sleep(TARGETED_PACING_MS);
      }
      if (!options.automatic) {
        setStatus(tt('frRefreshDone', '已刷新 {{COUNT}} 个账号')
          .replace('{{COUNT}}', String(scanControl.count)));
      }
    } finally {
      scanControl.active = false;
      schedulePersist();
      scheduleTimelineRefresh([]);
      emitStatus();
    }
  }

  // ─── Capsule for a leaderboard row ──────────────────────────────────
  function pillFor(handle, surface = 'leaderboard') {
    if (!settings.enabled || (surface === 'timeline' && !settings.timeline) || (surface === 'leaderboard' && !settings.leaderboard)) return null;
    const h = L.normalizeHandle(handle);
    if (!h) return null;
    const rec = state.users[h];
    const kind = L.classify(rec);
    const rate = L.computeRate(rec);
    const fmt = (n) => (n == null ? '\u2014' : String(n));
    const statsLine = rec
      ? `${tt('frFollowers', '粉丝')} ${fmt(rec.fc)} · ${tt('frFollowing', '关注')} ${fmt(rec.fd)} · ${tt('frRateLabel', '关注/粉丝比')} ${L.formatRate(rate)}`
      : '';
    const nameLine = rec?.n ? `${rec.n} (@${h})` : `@${h}`;
    const title = `${nameLine}${statsLine ? `\n${statsLine}` : ''}`;
    // Keep the capsule visible while the profile lookup is still pending. X
    // virtualises timeline rows, so hiding the unknown state makes some
    // tweets look as if the feature did not run. The dash is replaced by the
    // real ratio as soon as UserByScreenName/friendships data arrives.
    const shortRate = rate == null ? '\u2014' : String(rate);
    const rateLabel = (label) => `${label} ${shortRate}`;
    switch (kind) {
      case 'mutual':
        if (!settings.relations) return null;
        return { cls: 'xvm-fr-mutual', label: rateLabel(tt('frMutual', '互关')), title };
      case 'mine':
        if (!settings.relations) return null;
        return { cls: 'xvm-fr-mine', label: rateLabel(tt('frMine', '我关注了')), title };
      case 'theirs':
        if (!settings.relations) return null;
        return { cls: 'xvm-fr-theirs', label: rateLabel(tt('frTheirs', '关注我')), title };
      case 'unfollowed': {
        if (!settings.relations || !isFollowHistoryMember()) return null;
        const byThem = rec?.u;
        const byMe = rec?.i;
        const when = new Date(byThem || byMe || Date.now()).toLocaleDateString();
        const who = byThem ? tt('frUnfollowedMe', 'TA 取关了你') : tt('frIUnfollowed', '你取关了 TA');
        return { cls: 'xvm-fr-unfollowed', label: rateLabel(tt('frUnfollowed', '取关了')), title: `${title}\n${who} · ${when}` };
      }
      default:
        // No relationship — always show the profile's follow ratio. A dash is
        // intentional while X has not returned public counts yet.
        if (!settings.rate) return null;
        return {
          cls: 'xvm-fr-rate',
          label: `${tt('frRate', '关注率')} ${shortRate}`,
          title: `${title}\n${tt('frRateLabel', '关注/粉丝比')} ${shortRate}`,
        };
    }
  }

  function renderPillContent(element, data, handle) {
    const h = L.normalizeHandle(handle);
    const rec = h ? state.users[h] : null;
    const rate = L.computeRate(rec);
    const signature = JSON.stringify([
      data?.label || '', h || '', rec?.fc ?? null, rec?.fd ?? null,
      rate ?? null, Boolean(rec?.u),
    ]);
    // MutationObserver 会持续巡视 X 的虚拟列表。数据未变化时保留现有 DOM，
    // 避免悬浮框闪烁、胶囊位置抖动和无意义的再次扫描。
    if (element.dataset.xvmFrRender === signature
      && (!data || element.querySelector('.xvm-fr-pill-label'))) return;
    element.dataset.xvmFrRender = signature;
    element.replaceChildren();
    if (!data) {
      if (profileTooltipOwner === element) hideProfileTooltip(element);
      element.onmouseenter = null;
      element.onmouseleave = null;
      element.onfocusin = null;
      element.onfocusout = null;
      element.removeAttribute('aria-describedby');
      return;
    }
    const label = document.createElement('span');
    label.className = 'xvm-fr-pill-label';
    label.textContent = data.label || '';
    element.appendChild(label);
    element.onmouseenter = () => showProfileTooltip(element, h);
    element.onmouseleave = () => hideProfileTooltip(element);
    element.onfocusin = () => showProfileTooltip(element, h);
    element.onfocusout = () => hideProfileTooltip(element);
    element.tabIndex = 0;
    element.setAttribute('aria-describedby', 'xvm-fr-tooltip-portal');
    element.setAttribute('aria-label', `${data.label || ''}，查看账号详情`);
  }

  function ensureProfileTooltipPortal() {
    if (profileTooltipPortal?.isConnected) return profileTooltipPortal;
    const tooltip = document.createElement('div');
    tooltip.id = 'xvm-fr-tooltip-portal';
    tooltip.className = 'xvm-fr-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    (document.body || document.documentElement).appendChild(tooltip);
    profileTooltipPortal = tooltip;
    return tooltip;
  }

  function fillProfileTooltip(tooltip, handle) {
    const rec = state.users[handle];
    const rate = L.computeRate(rec);
    const display = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '查询中';
    const relationship = {
      mutual: tt('frMutual', '互关'),
      mine: tt('frMine', '我关注了'),
      theirs: tt('frTheirs', '关注我'),
      unfollowed: tt('frUnfollowed', '取关了'),
      none: tt('frNoRelation', '无关系'),
    }[L.classify(rec)] || tt('frNoRelation', '无关系');
    const rows = [
      ['关系', relationship],
      ['粉丝', display(rec?.fc)],
      ['关注人数', display(rec?.fd)],
      ['关注率', rate == null ? '查询中' : String(rate)],
      ['对当前用户取关过', rec?.u ? '是' : '否'],
      ['数据状态', hasProfileCount(rec?.fc) && hasProfileCount(rec?.fd) ? '已同步' : '正在同步'],
    ];
    const title = document.createElement('strong');
    title.textContent = 'X-Tools 关系详情';
    const account = document.createElement('span');
    account.className = 'xvm-fr-tooltip-account';
    account.textContent = `@${handle || ''}`;
    tooltip.replaceChildren(title, account);
    for (const [key, value] of rows) {
      const line = document.createElement('span');
      const label = document.createElement('b');
      label.textContent = `${key}：`;
      line.append(label, document.createTextNode(value));
      tooltip.appendChild(line);
    }
  }

  function showProfileTooltip(owner, handle) {
    if (!owner?.isConnected) return;
    const tooltip = ensureProfileTooltipPortal();
    fillProfileTooltip(tooltip, handle);
    profileTooltipOwner = owner;
    tooltip.dataset.open = 'true';
    tooltip.style.display = 'block';
    tooltip.style.visibility = 'hidden';
    tooltip.style.left = '0px';
    tooltip.style.top = '0px';
    const anchor = owner.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const margin = 8;
    const gap = 9;
    const maxLeft = Math.max(margin, window.innerWidth - box.width - margin);
    const left = Math.min(maxLeft, Math.max(margin, anchor.right - box.width));
    const below = anchor.bottom + gap;
    const above = anchor.top - box.height - gap;
    const placement = below + box.height <= window.innerHeight - margin || above < margin ? 'bottom' : 'top';
    const top = placement === 'bottom'
      ? Math.min(window.innerHeight - box.height - margin, Math.max(margin, below))
      : Math.max(margin, above);
    tooltip.dataset.placement = placement;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
    tooltip.style.setProperty('--xvm-fr-tooltip-arrow-left', `${Math.min(box.width - 18, Math.max(18, anchor.left + anchor.width / 2 - left))}px`);
    tooltip.style.visibility = 'visible';
  }

  function hideProfileTooltip(owner) {
    if (owner && profileTooltipOwner !== owner) return;
    if (profileTooltipPortal) {
      delete profileTooltipPortal.dataset.open;
      profileTooltipPortal.style.display = 'none';
    }
    profileTooltipOwner = null;
  }

  function isFollowHistoryMember() {
    if (window.__xvmIsCommunityDevBuild === true) return true;
    const tier = window.__xvmPro?.getCurrentTier?.() || 'free';
    return ['standard', 'pro', 'max'].includes(tier);
  }

  window.__xvmPro?.onTierChange?.(() => {
    applyToTimeline();
    scheduleEmit();
  });

  // ─── Init ───────────────────────────────────────────────────────────
  let timelineObserver = null;
  let timelineTick = 0;
  function startTimelineObserver() {
    if (timelineObserver) return;
    // The MAIN-world script runs at document_start.  X can load this module
    // before <body> exists; observing null aborts the whole radar IIFE and
    // leaves __xvmFollowRadar undefined.  Fall back to documentElement and
    // retry after DOMContentLoaded for the rare pre-documentElement case.
    const observeRoot = document.body || document.documentElement;
    if (!observeRoot) {
      document.addEventListener('DOMContentLoaded', startTimelineObserver, { once: true });
      return;
    }
    // X re-mounts tweet nodes constantly (virtualised list). A MutationObserver
    // on body catches inserts; we also run a periodic sweep because X sometimes
    // reuses nodes without firing childList mutations.
    timelineObserver = new MutationObserver(() => { scheduleTimelineTick(); });
    timelineObserver.observe(observeRoot, { childList: true, subtree: true });
    scheduleTimelineTick();
  }
  function scheduleTimelineTick() {
    // Coalesce bursts: one pass per ~600ms no matter how many mutations fire.
    if (timelineTick) return;
    timelineTick = setTimeout(() => {
      timelineTick = 0;
      applyToTimeline();
      applyToUserCards();
      scheduleEmit();
    }, 600);
  }

  (async function init() {
    // Start observing immediately.  X often completes its first timeline
    // GraphQL request during the storage round trip; the network hook's
    // replay buffer helps, but subscribing first removes that race entirely.
    subscribe();
    startTimelineObserver();
    discoverUserByScreenNameTemplate();
    const data = await loadFromStorage();
    if (data && typeof data === 'object') {
      state = {
        // Keep records captured while storage was loading.  Live response
        // data wins because it is newer than the persisted snapshot.
        users: { ...(data.users || {}), ...state.users },
        snap: state.snap || data.snap || null,
        events: [...(Array.isArray(data.events) ? data.events : []), ...state.events].slice(-EVENTS_MAX),
        meta: { ...(data.meta || {}), ...state.meta },
      };
    }
    loaded = true;
    // A timeline pass before storage completed could only see the live cache;
    // run one more after merging persisted relationships.
    applyToTimeline();
    applyToUserCards();
    setStatus(tt('frScanIdle', '就绪'));
    emitStatus();
  })();

  window.__xvmFollowRadar = {
    pillFor,
    scanFollowing: () => scanList('following'),
    scanFollowers: () => scanList('followers'),
    refreshHandles,
    ingestProfileRow,
    applyToTimeline,
    abort: () => { scanControl.active = false; },
    getStatus: () => ({ status: statusText, busy: scanControl.active }),
    isReady: () => loaded,
    // Debug helper — run in the page console to see why a pill isn't showing.
    debug: (handle) => {
      const h = L.normalizeHandle(handle);
      const rec = state.users[h];
      const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
      const onScreen = articles.filter((a) => {
        const link = a.querySelector('[data-testid="User-Name"] a[role="link"][href^="/"]');
        return link && (link.getAttribute('href') || '').toLowerCase().includes('/' + h);
      });
      return {
        handle: h,
        record: rec || null,
        classify: L.classify(rec),
        pill: pillFor(h, 'timeline'),
        templates: state.meta.templates,
        myUserId: state.meta.myUserId,
        userCount: Object.keys(state.users).length,
        timelineArticles: articles.length,
        matchingArticles: onScreen.length,
        settings: { ...settings },
        pendingRefresh: [...timelineRefreshPending],
        pendingRelationshipLookup: [...relationshipLookupPending.keys()],
        ready: loaded,
      };
    },
  };
})();
