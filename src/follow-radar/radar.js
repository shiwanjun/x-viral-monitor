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
    queryId: 'SAMkL5y_N9pmahSw8yy6gw',
    authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    features: JSON.stringify({
      responsive_web_graphql_timeline_navigation_enabled: false,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      responsive_web_twitter_blue_verified_badge_is_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      withAuxiliaryUserLabels: true,
    }),
  };
  const TIMELINE_REFRESH_COOLDOWN_MS = 2500;
  const TIMELINE_REFRESH_BATCH = 30;
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
      const pill = pillFor(h, 'timeline');
      el.style.display = pill ? '' : 'none';
      el.className = `xvm-fr-pill ${pill ? pill.cls : 'xvm-fr-rate'}`;
      el.textContent = pill ? pill.label : '';
      if (pill?.title) el.setAttribute('title', pill.title);
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
    const before = JSON.stringify({ id: cur?.id, f: cur?.f, b: cur?.b, fc: cur?.fc, fd: cur?.fd });
    const { rec, events } = L.mergeUser(cur, u, now);
    if (u.id) rec.id = String(u.id);
    const after = JSON.stringify({ id: rec.id, f: rec.f, b: rec.b, fc: rec.fc, fd: rec.fd });
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

  function subscribe() {
    const net = window.__xvmNet;
    if (net?.onResponse) {
      dbg('subscribing via __xvmNet');
      net.onResponse(/graphql/, async ({ url, response, source }) => {
        try {
          const json = source === 'fetch' ? await response.clone().json() : await response.json();
          ingest(json, url);
        } catch (_) {}
      });
    } else {
      // Fallback: if __xvmNet isn't ready (load-order race), hook fetch
      // ourselves. This is a one-shot; once __xvmNet appears we don't switch.
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
    if (caret && anchor?.parentElement === host && pill.parentElement !== host) host.insertBefore(pill, anchor);
    else if (!pill.parentElement) host.appendChild(pill);
    pill.setAttribute('data-xvm-fr-handle', handle);
    const data = pillFor(handle, 'timeline');
    if (!data) {
      pill.style.display = 'none';
      pill.textContent = '';
      return false;
    }
    pill.style.display = '';
    pill.className = `xvm-fr-pill ${data.cls}`;
    pill.textContent = data.label;
    if (data.title) pill.setAttribute('title', data.title);
    return true;
  }

  function applyToTimeline() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    if (!settings.enabled || !settings.timeline) {
      document.querySelectorAll('.xvm-fr-pill').forEach((pill) => { pill.style.display = 'none'; });
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
      visibleHandles.push(handle);
      if (ensureTimelinePill(article, handle)) { anyShown = true; withData++; }
    }
    scheduleTimelineRefresh(visibleHandles);
    if (articles.length) dbg('applyToTimeline:', articles.length, 'articles,', withData, 'with pill data,', Object.keys(state.users).length, 'users cached');
    return anyShown;
  }

  // ─── Active GraphQL calls ───────────────────────────────────────────
  function radarTemplate(op) {
    const stored = state.meta.templates?.[op];
    if (stored?.queryId && stored.queryId !== 'REPLACE_AT_RUNTIME') return stored;
    const chart = window.__XVMStarChart?._internal?.getTemplate?.(op);
    if (chart?.queryId && chart.queryId !== 'REPLACE_AT_RUNTIME') return chart;
    return op === 'UserByScreenName' ? FALLBACK_USER_BY_SCREEN_NAME_TEMPLATE : null;
  }

  function discoverUserByScreenNameTemplate() {
    if (state.meta.templates?.UserByScreenName?.queryId) return;
    const urls = [...new Set([
      ...Array.from(document.scripts || []).map((s) => s.src),
      ...performance.getEntriesByType('resource').map((e) => e.name),
    ].filter((u) => /abs\.twimg\.com\/responsive-web\/client-web\/.*\.js/.test(u)))];
    if (!urls.length) return;
    Promise.all(urls.slice(0, 12).map(async (url) => {
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
      if (!template || state.meta.templates?.UserByScreenName?.queryId) return;
      state.meta.templates = { ...(state.meta.templates || {}), UserByScreenName: {
        ...FALLBACK_USER_BY_SCREEN_NAME_TEMPLATE, ...template,
      } };
      schedulePersist();
    }).catch(() => {});
  }

  function scheduleTimelineRefresh(handles) {
    if (!settings.enabled || !settings.timeline) return;
    for (const h of handles || []) {
      const rec = state.users[L.normalizeHandle(h)];
      if (!rec || ![0, 1].includes(rec.f) || ![0, 1].includes(rec.b)) {
        timelineRefreshPending.add(h);
      }
    }
    if (!timelineRefreshPending.size || timelineRefreshTimer) return;
    timelineRefreshTimer = setTimeout(() => {
      timelineRefreshTimer = 0;
      const batch = [...timelineRefreshPending].slice(0, TIMELINE_REFRESH_BATCH);
      if (scanControl.active) {
        scheduleTimelineRefresh([]);
        return;
      }
      batch.forEach((h) => timelineRefreshPending.delete(h));
      refreshHandles(batch, { automatic: true });
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
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${op}`);
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
          if (e.type === 'unfollowed_me') rec.u = e.ts; else rec.i = e.ts;
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
            withSafetyModeUserFields: true,
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
    const rateLabel = (label) => rate == null ? label : `${label} ${L.formatRate(rate)}`;
    switch (kind) {
      case 'mutual':
        if (!settings.relations) return null;
        return { cls: 'xvm-fr-mutual', label: rateLabel(tt('frMutual', '互关')), title };
      case 'mine':
        if (!settings.relations) return null;
        return { cls: 'xvm-fr-mine', label: rateLabel(tt('frMine', '我关注')), title };
      case 'theirs':
        if (!settings.relations) return null;
        return { cls: 'xvm-fr-theirs', label: rateLabel(tt('frTheirs', '关注我')), title };
      case 'unfollowed': {
        if (!settings.relations || !isFollowHistoryMember()) return null;
        const byThem = rec?.u;
        const byMe = rec?.i;
        const when = new Date(byThem || byMe || Date.now()).toLocaleDateString();
        const who = byThem ? tt('frUnfollowedMe', 'TA 取关了你') : tt('frIUnfollowed', '你取关了 TA');
        return { cls: 'xvm-fr-unfollowed', label: rateLabel(tt('frUnfollowed', '取消关注')), title: `${title}\n${who} · ${when}` };
      }
      default:
        // No relationship — show the profile's follow ratio when known.
        if (!settings.rate || rate == null) return null;
        return {
          cls: 'xvm-fr-rate',
          label: `${tt('frRate', '关注率')} ${L.formatRate(rate)}`,
          title: `${title}\n${tt('frRateLabel', '关注/粉丝比')} ${L.formatRate(rate)}`,
        };
    }
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
    setStatus(tt('frScanIdle', '就绪'));
    emitStatus();
  })();

  window.__xvmFollowRadar = {
    pillFor,
    scanFollowing: () => scanList('following'),
    scanFollowers: () => scanList('followers'),
    refreshHandles,
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
