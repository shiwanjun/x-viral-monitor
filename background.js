if (typeof importScripts === 'function') importScripts(
  'lib/library-db.js',
  'lib/library-normalize.js',
  'lib/library-sync-engine.js',
  'lib/library-query-discovery.js',
);

const PLACEHOLDER = '[推文内容]';
const DEFAULT_PROVIDER = 'x-grok';
const DEFAULT_PLATFORM = 'openai';
const DEFAULT_REPLY_COUNT = 10;

const OPENAI_COMPAT_PLATFORMS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
  },
  kimi: {
    label: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'moonshot-v1-8k',
  },
  qwen: {
    label: 'Qwen / DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  siliconflow: {
    label: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Pro/zai-org/GLM-4.7',
  },
  lmstudio: {
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    local: true,
  },
  ollamaOpenAI: {
    label: 'Ollama (OpenAI compatible)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    local: true,
  },
};

const ALLOWED_OPENAI_PREFIXES = [
  'https://api.openai.com/v1',
  'https://api.deepseek.com',
  'https://openrouter.ai/api/v1',
  'https://api.moonshot.ai/v1',
  'https://api.moonshot.cn/v1',
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
  'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
  'https://api.siliconflow.cn/v1',
  'https://api.siliconflow.com/v1',
  'http://localhost:1234/v1',
  'http://127.0.0.1:1234/v1',
  'http://localhost:11434/v1',
  'http://127.0.0.1:11434/v1',
];

const SYNC_DEFAULTS = {
  aiProvider: DEFAULT_PROVIDER,
  aiOpenAIPlatform: DEFAULT_PLATFORM,
  aiBaseUrl: OPENAI_COMPAT_PLATFORMS[DEFAULT_PLATFORM].baseUrl,
  aiModel: OPENAI_COMPAT_PLATFORMS[DEFAULT_PLATFORM].model,
  aiReplyCount: DEFAULT_REPLY_COUNT,
  aiLanguage: 'auto',
};
const LOCAL_DEFAULTS = { xvmAiApiKey: '' };
const AUTH_BACKEND_URL = 'https://x.jieyiai.dev';
const SESSION_KEY = 'xvm_session_v1';
const SUBSCRIPTION_KEY = 'xvm_subscription_v1';
const WEBSITE_ORIGIN = 'https://x.jieyiai.dev';
const LIBRARY_BINDING_KEY = 'xvm_library_bound_account_v1';
const LIBRARY_SYNC_KEY = 'xvm_library_sync_status_v1';
const LIBRARY_MIGRATED_KEY = 'xvm_library_bookmarks_migrated_v1';
const LIBRARY_DEVICE_KEY = 'xvm_library_device_id_v1';
const LIBRARY_AUTH_KEY = 'xvm_library_x_auth_v1';
const LIBRARY_QUERY_DISCOVERY_KEY = 'xvm_library_query_discovery_v1';
const RELATIONSHIP_COMMITTED_KEY = 'xvm_relationship_committed_v1';
const RELATIONSHIP_SYNC_KEY = 'xvm_relationship_sync_v1';
const LIBRARY_AUTO_SYNC_ALARM = 'xvm-library-auto-sync';
const COMMUNITY_X_CONFIG_URL = 'https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json';
const pendingLibraryActions = new Map();
const pendingLibraryAi = new Map();

async function storedLibraryTemplates({ resume = false } = {}) {
  const keys = ['Bookmarks', 'BookmarkFolderTimeline', 'Likes', 'UserTweets', 'UserTweetsAndReplies', 'Following', 'Followers', 'DeleteBookmark', 'UnfavoriteTweet', 'DeleteTweet'].map((operation) => `xvm_library_template_${operation}`);
  const values = await chrome.storage.local.get(keys);
  const context = await libraryContext();
  return keys.map((key) => values?.[key]).filter((template) => template?.operation && template?.queryId && template?.baseUrl).map((template) => {
    const progress = context.sync?.operations?.[template.operation] || {};
    return { ...template, highWaterId: progress.highWaterId || '', resumeCursor: resume ? progress.cursor || '' : '' };
  });
}

async function refreshCommunityLibraryTemplates(accountId, { force = false } = {}) {
  const templateKeys = ['Bookmarks', 'BookmarkFolderTimeline', 'Likes', 'UserTweets', 'UserTweetsAndReplies', 'Following', 'Followers'].map((operation) => `xvm_library_template_${operation}`);
  const existing = await chrome.storage.local.get([...templateKeys, LIBRARY_QUERY_DISCOVERY_KEY]);
  const cachedDiscovery = existing?.[LIBRARY_QUERY_DISCOVERY_KEY] || {};
  let config = {};
  try {
    const response = await fetch(COMMUNITY_X_CONFIG_URL, { cache: 'no-store' });
    if (response.ok) config = await response.json();
  } catch (_) {}
  let discovered = cachedDiscovery.ids || {};
  const discoveryFresh = Date.now() - Number(cachedDiscovery.updatedAt || 0) < 6 * 60 * 60 * 1000;
  const operations = ['Bookmarks', 'Likes', 'UserTweets', 'UserTweetsAndReplies', 'Following', 'Followers'];
  const hasUsableFallback = operations.every((operation) => existing?.[`xvm_library_template_${operation}`]?.queryId || config?.[operation]?.queryId);
  if (force || (!discoveryFresh && !hasUsableFallback)) {
    try {
      const ids = await XvmLibraryQueryDiscovery.discover({ fetchFn: fetch.bind(globalThis) });
      if (Object.keys(ids).length) {
        discovered = { ...discovered, ...ids };
        await chrome.storage.local.set({ [LIBRARY_QUERY_DISCOVERY_KEY]: { ids: discovered, updatedAt: Date.now() } });
      }
    } catch (_) {}
  }
  const stored = {};
  for (const operation of operations) {
    const current = existing?.[`xvm_library_template_${operation}`] || {};
    const item = config?.[operation];
    const queryId = discovered[operation] || current.queryId || item?.queryId;
    if (!queryId) continue;
    const variables = { ...(item?.variables || current.variables || {}), count: 100 };
    if (operation.startsWith('UserTweets') || ['Likes', 'Following', 'Followers'].includes(operation)) variables.userId = String(accountId);
    stored[`xvm_library_template_${operation}`] = {
      operation,
      queryId,
      baseUrl: `https://x.com/i/api/graphql/${queryId}/${operation}`,
      variables,
      params: {
        ...(item?.features ? { features: JSON.stringify(item.features) } : current.params?.features ? { features: current.params.features } : {}),
        ...(item?.fieldToggles ? { fieldToggles: JSON.stringify(item.fieldToggles) } : current.params?.fieldToggles ? { fieldToggles: current.params.fieldToggles } : {}),
      },
      method: 'GET',
      capturedAt: Date.now(),
      source: discovered[operation] ? 'bundle-discovery' : current.queryId ? 'passive-capture' : 'community-config',
    };
  }
  await chrome.storage.local.set(stored);
  return Object.values(stored);
}

async function freshCsrfToken(fallback = '') {
  if (!chrome.cookies?.get) return fallback;
  try { return (await chrome.cookies.get({ url: 'https://x.com', name: 'ct0' }))?.value || fallback; }
  catch (_) { return fallback; }
}

async function buildBackgroundReplay(template, cursor, auth) {
  const variables = { ...(template.variables || {}), count: Math.min(100, Number(template.variables?.count || 100)) };
  if (cursor) variables.cursor = cursor; else delete variables.cursor;
  const url = new URL(template.baseUrl);
  url.searchParams.set('variables', JSON.stringify(variables));
  Object.entries(template.params || {}).forEach(([key, value]) => { if (value) url.searchParams.set(key, value); });
  return {
    url: url.href,
    init: {
      method: 'GET', credentials: 'include',
      headers: {
        authorization: auth.authorization,
        'x-csrf-token': await freshCsrfToken(auth.csrfToken),
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
      },
    },
  };
}

async function runBackgroundLibrarySync(selectedTemplates, { mode, accountId, auth, context, jobId }) {
  const deviceId = await ensureDeviceId();
  const operationStates = { ...(context.sync?.operations || {}) };
  let accepted = 0;
  for (const template of selectedTemplates) {
    let progress = XvmLibrarySyncEngine.initialOperationState(operationStates[template.operation] || {}, mode);
    const maxPages = mode === 'full' ? 2000 : 5;
    while (progress.pages < maxPages && progress.status !== 'done') {
      const live = await libraryContext();
      if (live.sync?.jobId !== jobId || live.sync?.status === 'paused') throw new Error('sync_paused');
      const request = await buildBackgroundReplay(template, progress.cursor, auth);
      const { payload: json, rateLimit } = await XvmLibrarySyncEngine.fetchPage({
        fetchFn: fetch.bind(globalThis),
        request,
        onRetry: ({ status, retryMs }) => {
          chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: { ...live.sync, status, retryMs, currentOperation: template.operation, updatedAt: Date.now() } }).catch(() => {});
        },
      });
      const records = XvmLibraryNormalize.findTweets(json)
        .map((tweet) => XvmLibraryNormalize.normalizeTweet(tweet, XvmLibraryNormalize.kindForOperation(template.operation), accountId))
        .filter(Boolean).map((record) => ({ ...record, accountId, deviceId }));
      const result = await XvmLibraryDb.putCaptures(records);
      accepted += result.accepted || 0;
      progress = XvmLibrarySyncEngine.advanceOperation(progress, {
        mode,
        records,
        cursor: XvmLibraryNormalize.cursorFrom(json),
        inserted: result.inserted,
        updated: result.updated,
      });
      operationStates[template.operation] = { ...progress, rateLimit };
      const current = await libraryContext();
      if (current.sync?.jobId !== jobId) throw new Error('sync_superseded');
      await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: {
        ...current.sync,
        status: progress.status === 'done' ? 'running' : progress.status,
        mode,
        currentOperation: template.operation,
        operations: operationStates,
        updatedAt: Date.now(),
      } });
      if (progress.status === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, XvmLibrarySyncEngine.jitteredDelay()));
    }
    if (progress.pages >= maxPages && progress.status !== 'done') operationStates[template.operation] = { ...progress, status: 'paused', stopReason: 'page_limit' };
  }
  return { accepted, operations: operationStates };
}

async function availableLibraryOperations() {
  return (await storedLibraryTemplates()).map((template) => template.operation);
}

function libraryError(error, fallback = 'library_error') {
  const code = String(error?.message || error || fallback);
  return { ok: false, error: code };
}

function subscriptionIsPro(subscription) {
  const plan = subscription?.tier || subscription?.plan;
  const status = String(subscription?.status || 'active');
  const end = Number(subscription?.expiresAt || subscription?.currentPeriodEnd || 0);
  return ['standard', 'pro', 'max'].includes(plan) && ['active', 'trialing', 'canceling'].includes(status) && (!end || end > Date.now());
}

async function libraryContext() {
  const values = await chrome.storage.local.get([SESSION_KEY, SUBSCRIPTION_KEY, LIBRARY_BINDING_KEY, LIBRARY_SYNC_KEY]);
  return {
    signedIn: Boolean(values?.[SESSION_KEY]?.token),
    session: values?.[SESSION_KEY] || null,
    subscription: values?.[SUBSCRIPTION_KEY] || null,
    isPro: subscriptionIsPro(values?.[SUBSCRIPTION_KEY]),
    boundAccount: values?.[LIBRARY_BINDING_KEY] || null,
    sync: values?.[LIBRARY_SYNC_KEY] || { status: 'idle', updatedAt: 0, operations: {} },
  };
}

async function ensureDeviceId() {
  const stored = await chrome.storage.local.get(LIBRARY_DEVICE_KEY);
  if (stored?.[LIBRARY_DEVICE_KEY]) return stored[LIBRARY_DEVICE_KEY];
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [LIBRARY_DEVICE_KEY]: id });
  return id;
}

async function ensureLibraryBinding(accountId) {
  const id = String(accountId || '').trim();
  if (!id) throw new Error('account_mismatch');
  const values = await chrome.storage.local.get(LIBRARY_BINDING_KEY);
  const bound = values?.[LIBRARY_BINDING_KEY];
  if (bound?.accountId && bound.accountId !== id) throw new Error('account_mismatch');
  if (!bound?.accountId) await chrome.storage.local.set({ [LIBRARY_BINDING_KEY]: { accountId: id, boundAt: Date.now() } });
  return id;
}

async function migrateLegacyBookmarks(accountId) {
  const values = await chrome.storage.local.get([LIBRARY_MIGRATED_KEY, 'bookmarkTimelineCache', 'bookmarkFoldersCache']);
  if (values?.[LIBRARY_MIGRATED_KEY]) return;
  const snapshot = makeWebsiteDashboardSnapshot(values);
  const records = snapshot.rows.map((row) => ({
    accountId, kind: 'bookmark', sourceFolderId: row.folderId, sourceFolderName: row.folderName,
    post: { id: row.id, text: row.text, authorName: row.name, authorHandle: row.handle, authorAvatar: row.avatar, media: row.media.map((url) => ({ type: 'image', url })), metrics: { views: row.views, likes: row.engagement }, createdAt: Date.now() },
  }));
  await XvmLibraryDb.putCaptures(records);
  await chrome.storage.local.set({ [LIBRARY_MIGRATED_KEY]: { migratedAt: Date.now(), count: records.length } });
}

async function broadcastLibraryCommand(message) {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://pro.x.com/*'] });
  if (!tabs.length) throw new Error('x_tab_required');
  const results = await Promise.allSettled(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, message)));
  return results.some((result) => result.status === 'fulfilled');
}

async function libraryStatus() {
  const context = await libraryContext();
  const facets = await XvmLibraryDb.facets({ isPro: context.isPro });
  const cloudBackup = Boolean(context.sync?.cloudBackup);
  return {
    ok: true, connected: true, signedIn: context.signedIn, isPro: context.isPro,
    account: context.boundAccount, sync: context.sync, ...facets,
    cloudBackup, readOnly: Boolean(context.sync?.readOnly || (cloudBackup && !context.isPro)),
    availableOperations: await availableLibraryOperations(),
  };
}

async function relationshipStatus() {
  const values = await chrome.storage.local.get(['followRadarV1', 'followRadarCloudSync', RELATIONSHIP_COMMITTED_KEY, RELATIONSHIP_SYNC_KEY]);
  const radar = values?.followRadarV1 || {};
  let committed = values?.[RELATIONSHIP_COMMITTED_KEY] || {};
  // 旧版本只保存 followRadarV1。升级后先把最后一份完整快照迁移为
  // committed，再启动新扫描；这样工作台首屏不会从已有的几百条跳成 0。
  if (!Object.keys(committed.users || {}).length && Object.keys(radar.users || {}).length) {
    const snap = radar.snap || { following: {}, followers: {} };
    const users = {};
    Object.entries(radar.users || {}).forEach(([handle, record]) => {
      const inFollowing = Boolean(snap.following?.[handle]);
      const inFollowers = Boolean(snap.followers?.[handle]);
      if (!inFollowing && !inFollowers && !record?.f && !record?.b && !record?.u && !record?.i) return;
      users[handle] = {
        ...record,
        f: Object.keys(snap.following || {}).length ? Number(inFollowing) : Number(Boolean(record?.f)),
        b: Object.keys(snap.followers || {}).length ? Number(inFollowers) : Number(Boolean(record?.b)),
      };
    });
    committed = {
      accountId: radar.meta?.accountId || '',
      users,
      snap,
      meta: { migratedAt: Date.now(), committedAt: Number(radar.meta?.backgroundScannedAt || radar.meta?.lastScanAt || Date.now()) },
    };
    await chrome.storage.local.set({ [RELATIONSHIP_COMMITTED_KEY]: committed });
  }
  const users = Object.entries(committed.users || {}).map(([handle, record]) => ({ handle, ...record }));
  const events = (Array.isArray(radar.events) ? radar.events : []).slice().sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  const counts = users.reduce((result, user) => {
    const key = user.f && user.b ? 'mutual' : user.m ? 'unfollowed' : user.f ? 'mine' : user.b ? 'theirs' : (user.u || user.i) ? 'unfollowed' : 'none';
    result[key] = (result[key] || 0) + 1; return result;
  }, { mutual: 0, mine: 0, theirs: 0, unfollowed: 0, none: 0 });
  return {
    ok: true,
    users,
    events,
    counts,
    cloudSync: Boolean(values?.followRadarCloudSync),
    meta: { ...(radar.meta || {}), ...(committed.meta || {}) },
    sync: values?.[RELATIONSHIP_SYNC_KEY] || { status: 'idle' },
  };
}

async function runBackgroundRelationshipScan(kinds = ['following', 'followers']) {
  const scanId = crypto.randomUUID();
  const startedAt = Date.now();
  await chrome.storage.local.set({ [RELATIONSHIP_SYNC_KEY]: { status: 'running', scanId, kinds, startedAt, updatedAt: startedAt, pages: 0 } });
  try {
    const context = await libraryContext();
    const accountId = context.boundAccount?.accountId;
    if (!accountId) throw new Error('x_account_required');
    const [values, sessionValues] = await Promise.all([
      chrome.storage.local.get(['followRadarV1', RELATIONSHIP_COMMITTED_KEY]),
      chrome.storage.session.get(LIBRARY_AUTH_KEY),
    ]);
    const auth = sessionValues?.[LIBRARY_AUTH_KEY];
    if (!auth?.authorization || !auth?.csrfToken || auth.accountId !== accountId) throw new Error('x_auth_required');
    await refreshCommunityLibraryTemplates(accountId);
    const templates = await storedLibraryTemplates();
    const radar = values.followRadarV1 || { users: {}, events: [], meta: {} };
    const previousCommitted = values?.[RELATIONSHIP_COMMITTED_KEY] || {};
    const previousSnap = previousCommitted.snap || radar.snap || { following: {}, followers: {} };
    const snapshot = {
      following: kinds.includes('following') ? {} : { ...(previousSnap.following || {}) },
      followers: kinds.includes('followers') ? {} : { ...(previousSnap.followers || {}) },
      ts: Date.now(),
    };
    const observed = {};
    let totalPages = 0;
    for (const kind of kinds) {
      const operation = kind === 'following' ? 'Following' : 'Followers';
      const template = templates.find((item) => item.operation === operation);
      if (!template) throw new Error('missing_query_template');
      let cursor = '';
      const seenCursors = new Set();
      let pages = 0;
      do {
        const request = await buildBackgroundReplay(template, cursor, auth);
        const { payload: json } = await XvmLibrarySyncEngine.fetchPage({
          fetchFn: fetch.bind(globalThis),
          request,
          onRetry: ({ retryMs }) => chrome.storage.local.set({ [RELATIONSHIP_SYNC_KEY]: { status: 'rate_limited', scanId, kinds, startedAt, updatedAt: Date.now(), pages: totalPages, retryMs } }).catch(() => {}),
        });
        for (const incoming of XvmLibraryNormalize.extractUsers(json)) {
          const old = observed[incoming.handle] || radar.users?.[incoming.handle] || previousCommitted.users?.[incoming.handle] || {};
          observed[incoming.handle] = { ...old, ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => value !== undefined && value !== '')), t: Date.now() };
          snapshot[kind][incoming.handle] = Date.now();
        }
        const nextCursor = XvmLibraryNormalize.cursorFrom(json);
        pages += 1; totalPages += 1;
        await chrome.storage.local.set({ [RELATIONSHIP_SYNC_KEY]: { status: 'running', scanId, kinds, startedAt, updatedAt: Date.now(), pages: totalPages, current: kind } });
        if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) { cursor = ''; break; }
        seenCursors.add(nextCursor); cursor = nextCursor;
        if (cursor) await new Promise((resolve) => setTimeout(resolve, XvmLibrarySyncEngine.jitteredDelay()));
      } while (cursor && pages < 2000);
      if (cursor) throw new Error('relationship_page_limit');
    }

    const now = Date.now();
    const handles = new Set([...Object.keys(snapshot.following), ...Object.keys(snapshot.followers)]);
    const users = {};
    handles.forEach((handle) => {
      const record = observed[handle] || radar.users?.[handle] || previousCommitted.users?.[handle] || {};
      users[handle] = { ...record, f: snapshot.following[handle] ? 1 : 0, b: snapshot.followers[handle] ? 1 : 0, t: now };
    });
    const events = new Map((radar.events || []).map((event) => [event.id || `${event.type}:${event.h}:${event.ts}`, event]));
    if (kinds.includes('followers')) Object.keys(previousSnap.followers || {}).forEach((handle) => {
      if (snapshot.followers[handle]) return;
      const record = previousCommitted.users?.[handle] || radar.users?.[handle] || {};
      const item = { id: `unfollowed_me:${handle}:${now}`, h: handle, n: record.n || '', type: 'unfollowed_me', ts: now, fc: record.fc ?? null, fd: record.fd ?? null };
      events.set(item.id, item);
    });
    if (kinds.includes('following')) Object.keys(previousSnap.following || {}).forEach((handle) => {
      if (snapshot.following[handle]) return;
      const record = previousCommitted.users?.[handle] || radar.users?.[handle] || {};
      const item = { id: `i_unfollowed:${handle}:${now}`, h: handle, n: record.n || '', type: 'i_unfollowed', ts: now, fc: record.fc ?? null, fd: record.fd ?? null };
      events.set(item.id, item);
    });
    const nextRadar = { ...radar, users: { ...(radar.users || {}), ...users }, snap: snapshot, events: [...events.values()].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0)).slice(-1000), meta: { ...(radar.meta || {}), backgroundScannedAt: now } };
    const committed = { accountId, users, snap: snapshot, meta: { committedAt: now, pages: totalPages, scanId } };
    await chrome.storage.local.set({
      followRadarV1: nextRadar,
      [RELATIONSHIP_COMMITTED_KEY]: committed,
      [RELATIONSHIP_SYNC_KEY]: { status: 'idle', scanId, kinds, startedAt, completedAt: now, updatedAt: now, pages: totalPages },
    });
    return { ok: true, users: Object.keys(users).length, pages: totalPages };
  } catch (error) {
    await chrome.storage.local.set({ [RELATIONSHIP_SYNC_KEY]: { status: 'failed', scanId, kinds, startedAt, updatedAt: Date.now(), error: String(error?.message || error) } });
    throw error;
  }
}

async function startRelationshipScan(kinds = ['following', 'followers']) {
  const values = await chrome.storage.local.get(RELATIONSHIP_SYNC_KEY);
  const current = values?.[RELATIONSHIP_SYNC_KEY];
  if (['running', 'rate_limited'].includes(current?.status)) return { ok: true, background: true, alreadyRunning: true, sync: current };
  runBackgroundRelationshipScan(kinds).catch(() => {});
  return { ok: true, background: true, sync: { status: 'running', kinds, startedAt: Date.now() } };
}

function radarEventId(event = {}) {
  return String(event.id || event.eventId || `${event.type || event.eventType}:${event.h || event.handle}:${event.ts || event.occurredAt}`);
}

async function syncRelationshipCloud() {
  const context = await libraryContext();
  if (!context.signedIn) throw new Error('unauthorized');
  if (!context.isPro) throw new Error('membership_required');
  const values = await chrome.storage.local.get(['followRadarV1', 'followRadarCloudSync']);
  if (!values.followRadarCloudSync) throw new Error('cloud_sync_disabled');
  const radar = values.followRadarV1 || {};
  const localEvents = Array.isArray(radar.events) ? radar.events : [];
  if (localEvents.length) await cloudRequest('/api/follow-radar/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: localEvents.slice(0, 1000) }) });
  const remote = await cloudRequest('/api/follow-radar/events?limit=1000');
  const merged = new Map(localEvents.map((event) => [radarEventId(event), event]));
  (remote.events || []).forEach((event) => {
    const normalized = { id: event.eventId, h: event.handle, n: event.displayName, type: event.eventType, ts: event.occurredAt, fc: event.followersCount, fd: event.followingCount };
    merged.set(radarEventId(normalized), { ...(merged.get(radarEventId(normalized)) || {}), ...normalized });
  });
  const events = [...merged.values()].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, 1000);
  await chrome.storage.local.set({ followRadarV1: { ...radar, events, meta: { ...(radar.meta || {}), cloudSyncedAt: Date.now() } } });
  return { ok: true, events: events.length, retention: remote.retention || 'full' };
}

async function libraryMutate(payload = {}) {
  const action = payload.action;
  if (action === 'create_tag') return { ok: true, value: await XvmLibraryDb.createTag(payload.name, payload.color) };
  if (action === 'create_folder') return { ok: true, value: await XvmLibraryDb.createFolder(payload.name, payload.color) };
  if (action === 'assign_tag') return { ok: true, ...(await XvmLibraryDb.assignTag(payload.itemIds, payload.targetId)) };
  if (action === 'assign_folder') return { ok: true, ...(await XvmLibraryDb.assignFolder(payload.itemIds, payload.targetId)) };
  if (action === 'archive' || action === 'restore') return { ok: true, ...(await XvmLibraryDb.archive(payload.itemIds, action === 'archive')) };
  if (action === 'list_archived') return { ok: true, rows: await XvmLibraryDb.listArchived(payload.limit || 50) };
  if (action === 'save_filter') {
    const context = await libraryContext(); if (!context.isPro) throw new Error('membership_required');
    const name = String(payload.name || '').trim().slice(0, 80); if (!name) throw new Error('invalid_name');
    const current = (await XvmLibraryDb.getSyncState('saved_filters'))?.items || [];
    const value = { id: crypto.randomUUID(), name, query: payload.query || {}, updatedAt: Date.now() };
    await XvmLibraryDb.setSyncState('saved_filters', { items: [value, ...current.filter((item) => item.id !== value.id)].slice(0, 30) });
    return { ok: true, value };
  }
  if (action === 'list_filters') return { ok: true, items: (await XvmLibraryDb.getSyncState('saved_filters'))?.items || [] };
  if (action === 'delete_filter') {
    const current = (await XvmLibraryDb.getSyncState('saved_filters'))?.items || [];
    await XvmLibraryDb.setSyncState('saved_filters', { items: current.filter((item) => item.id !== payload.id) });
    return { ok: true };
  }
  if (action === 'set_relationship_cloud') {
    const context = await libraryContext();
    if (!context.signedIn) throw new Error('unauthorized');
    const enabled = Boolean(payload.enabled);
    if (enabled && !context.isPro) throw new Error('membership_required');
    await chrome.storage.local.set({ followRadarCloudSync: enabled });
    if (enabled) await syncRelationshipCloud();
    return { ok: true, enabled };
  }
  if (action === 'set_cloud_backup') {
    const context = await libraryContext();
    if (!context.signedIn) throw new Error('unauthorized');
    if (payload.enabled && !context.isPro) throw new Error('membership_required');
    const sync = { ...context.sync, cloudBackup: Boolean(payload.enabled), readOnly: false, updatedAt: Date.now() };
    await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: sync });
    if (payload.enabled) {
      try { await pullLibraryCloud(); await pushLibraryCloud(); }
      catch (error) { await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: context.sync }); throw error; }
    }
    return { ok: true, sync };
  }
  throw new Error('unsupported_mutation');
}

async function cloudRequest(path, init = {}) {
  const context = await libraryContext();
  if (!context.session?.token) throw new Error('unauthorized');
  const response = await fetch(`${AUTH_BACKEND_URL}${path}`, { ...init, headers: { Accept: 'application/json', Authorization: `Bearer ${context.session.token}`, ...(init.headers || {}) } });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(data?.error || `cloud_http_${response.status}`);
  return data;
}

async function pullLibraryCloud() {
  const context = await libraryContext();
  if (!context.boundAccount?.accountId) throw new Error('x_account_required');
  const status = await cloudRequest('/api/library/sync/status');
  if (status.accountId && status.accountId !== context.boundAccount.accountId) throw new Error('account_mismatch');
  const cursor = Math.max(0, Number(context.sync?.cloudCursor || 0));
  let next = cursor; let applied = 0; let hasMore = true; let mode = status.mode || 'none';
  while (hasMore) {
    const data = await cloudRequest(`/api/library/sync/pull?cursor=${next}&limit=20`);
    mode = data.mode || mode;
    for (const chunk of (data.chunks || [])) if (chunk.accountId && chunk.accountId !== context.boundAccount.accountId) throw new Error('account_mismatch');
    for (const chunk of (data.chunks || [])) { const result = await XvmLibraryDb.applyChanges((chunk.changes || []).map((change) => ({ deviceId: chunk.deviceId || '', ...change }))); applied += result.applied; }
    next = Number(data.cursor || next); hasMore = Boolean(data.hasMore);
  }
  const sync = { ...context.sync, cloudCursor: next, cloudPulledAt: Date.now(), readOnly: mode === 'read_only', updatedAt: Date.now() };
  await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: sync });
  return { applied, cursor: next };
}

async function pushLibraryCloud(retried = false) {
  const context = await libraryContext();
  if (!context.sync?.cloudBackup || !context.isPro || !context.boundAccount?.accountId) return { skipped: true };
  const changes = await XvmLibraryDb.readOutbox(500);
  if (!changes.length) return { accepted: 0, cursor: context.sync?.cloudCursor || 0 };
  try {
    const batchId = `${changes[0].id}:${changes[0].updatedAt}:${changes.at(-1).id}:${changes.at(-1).updatedAt}:${changes.length}`.slice(0, 128);
    const data = await cloudRequest('/api/library/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: context.boundAccount.accountId, deviceId: await ensureDeviceId(), batchId, cursor: Number(context.sync?.cloudCursor || 0), changes }) });
    await XvmLibraryDb.ackOutbox(changes.map((change) => change.id));
    const sync = { ...context.sync, cloudCursor: data.cursor, cloudPushedAt: Date.now(), updatedAt: Date.now() };
    await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: sync });
    if (changes.length === 500) setTimeout(() => pushLibraryCloud().catch(() => {}), 250);
    return data;
  } catch (error) {
    if (!retried && String(error?.message) === 'cursor_conflict') { await pullLibraryCloud(); return pushLibraryCloud(true); }
    throw error;
  }
}

async function startLibrarySync(payload = {}) {
  const context = await libraryContext();
  if (payload.mode === 'full' && !context.isPro) throw new Error('membership_required');
  const mode = payload.mode || 'incremental';
  const resume = mode === 'full' && context.sync?.mode === 'full' && ['running', 'paused', 'failed', 'rate_limited'].includes(context.sync?.status);
  const requested = Array.isArray(payload.operations) ? payload.operations : [];
  let templates = await storedLibraryTemplates({ resume });
  const boundId = context.boundAccount?.accountId;
  if (boundId) {
    try { await refreshCommunityLibraryTemplates(boundId); templates = await storedLibraryTemplates({ resume }); } catch (_) {}
  }
  let selectedTemplates = requested.length ? templates.filter((template) => requested.includes(template.operation)) : templates;
  // BookmarkFolderTimeline 与 Bookmarks 是同一集合的两种入口；没有文件夹
  // 模板时不应阻止书签同步。其它分类至少要有一个可执行模板。
  selectedTemplates = selectedTemplates.filter((template, index, list) => list.findIndex((item) => item.operation === template.operation) === index);
  if (!selectedTemplates.length) throw new Error('missing_query_template');
  const jobId = crypto.randomUUID();
  const next = { ...context.sync, jobId, background: false, status: 'running', mode, operations: resume ? (context.sync?.operations || {}) : (context.sync?.operations || {}), startedAt: Date.now(), updatedAt: Date.now(), error: null, retryMs: 0 };
  try {
    await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: next });
    const stored = await chrome.storage.session.get(LIBRARY_AUTH_KEY);
    const authEnvelope = stored?.[LIBRARY_AUTH_KEY];
    const authFresh = authEnvelope?.authorization && authEnvelope?.csrfToken
      && Date.now() - Number(authEnvelope.capturedAt || 0) < 24 * 60 * 60 * 1000;
    if (boundId && authFresh && authEnvelope.accountId === boundId) {
      // 在扩展 service worker 内同步；无需保持 X 标签页打开。
      await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: { ...next, background: true } });
      runBackgroundLibrarySync(selectedTemplates, { mode, accountId: boundId, auth: authEnvelope, context: { ...context, sync: next }, jobId })
        .then(async (result) => {
          const current = await libraryContext();
          if (current.sync?.jobId !== jobId) return;
          await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: { ...current.sync, status: 'idle', background: false, currentOperation: '', operations: result.operations, lastSyncedAt: Date.now(), updatedAt: Date.now(), error: null, retryMs: 0 } });
          if (current.sync?.cloudBackup && current.isPro) pushLibraryCloud().catch(() => {});
          const relationValues = await chrome.storage.local.get(RELATIONSHIP_COMMITTED_KEY);
          const committedAt = Number(relationValues?.[RELATIONSHIP_COMMITTED_KEY]?.meta?.committedAt || 0);
          if (Date.now() - committedAt >= 6 * 60 * 60 * 1000) runBackgroundRelationshipScan(['following', 'followers']).catch(() => {});
        })
        .catch(async (error) => {
          const current = await libraryContext();
          if (current.sync?.jobId !== jobId || ['sync_paused', 'sync_superseded'].includes(String(error?.message || error))) return;
          await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: { ...current.sync, status: 'failed', background: false, error: String(error?.message || error), updatedAt: Date.now() } });
        });
      return { ok: true, background: true, sync: next, operations: selectedTemplates.map((template) => template.operation) };
    }
    const delivered = await broadcastLibraryCommand({ type: 'XVM_LIBRARY_SYNC_COMMAND', command: 'start', mode: next.mode, operations: selectedTemplates.map((template) => template.operation), templates: selectedTemplates });
    if (!delivered) throw new Error('x_auth_required');
    return { ok: true, background: false, sync: next, operations: selectedTemplates.map((template) => template.operation) };
  } catch (error) {
    await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: { ...context.sync, status: 'failed', mode, error: String(error?.message || error), updatedAt: Date.now() } });
    throw error;
  }
}

async function pauseLibrarySync() {
  const context = await libraryContext();
  const next = { ...context.sync, status: 'paused', updatedAt: Date.now() };
  await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: next });
  await broadcastLibraryCommand({ type: 'XVM_LIBRARY_SYNC_COMMAND', command: 'pause' }).catch(() => false);
  return { ok: true, sync: next };
}

async function maybeStartAutoLibrarySync() {
  const context = await libraryContext();
  if (!context.boundAccount?.accountId || ['running', 'rate_limited', 'network_retry', 'http_retry'].includes(context.sync?.status)) return { skipped: true };
  if (Date.now() - Number(context.sync?.lastAutoStartedAt || 0) < 30 * 60 * 1000) return { skipped: true };
  await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: { ...context.sync, lastAutoStartedAt: Date.now(), updatedAt: Date.now() } });
  return startLibrarySync({ mode: 'incremental' });
}

function ensureLibraryAutoSyncAlarm() {
  try { chrome.alarms?.create?.(LIBRARY_AUTO_SYNC_ALARM, { delayInMinutes: 1, periodInMinutes: 30 }); } catch (_) {}
}

async function runLibraryXAction(payload = {}) {
  const context = await libraryContext();
  if (!context.isPro) throw new Error('membership_required');
  const allowed = ['DeleteBookmark', 'UnfavoriteTweet', 'DeleteTweet'];
  if (!allowed.includes(payload.operation)) throw new Error('unsupported_x_action');
  const postIds = (Array.isArray(payload.postIds) ? payload.postIds : []).slice(0, 50);
  if (!postIds.length) throw new Error('invalid_request');
  if (!context.boundAccount?.accountId) throw new Error('account_mismatch');
  const validation = await XvmLibraryDb.validateXAction(context.boundAccount.accountId, payload.operation, postIds);
  if (!validation.valid) throw new Error('invalid_x_action_target');
  const requestId = crypto.randomUUID();
  const resultPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingLibraryActions.delete(requestId); reject(new Error('x_action_timeout')); }, Math.max(45_000, postIds.length * 4_000));
    pendingLibraryActions.set(requestId, (result) => { clearTimeout(timer); resolve(result); });
  });
  await broadcastLibraryCommand({ type: 'XVM_LIBRARY_X_ACTION_COMMAND', action: { requestId, operation: payload.operation, postIds: validation.accepted } });
  return { ok: true, results: await resultPromise };
}

function parseAiCategories(comments) {
  return Array.from(new Set((comments || []).flatMap((text) => String(text).split(/[，,、|/\n]/)).map((text) => text.replace(/^[#\-\d.\s]+/, '').trim()).filter((text) => text.length >= 2 && text.length <= 20))).slice(0, 8);
}

async function classifyLibrary(payload = {}) {
  const context = await libraryContext();
  if (!context.isPro) throw new Error('membership_required');
  const rows = (Array.isArray(payload.rows) ? payload.rows : []).slice(0, 20);
  if (!rows.length) throw new Error('invalid_request');
  const config = await loadConfig();
  const corpus = rows.map((row, index) => `${index + 1}. ${String(row.text || '').slice(0, 500)}`).join('\n');
  const aiPayload = { tweetText: corpus, promptTemplate: '[推文内容]\n\n请提炼 3-8 个可复用的中文内容标签，每行一个标签，不要解释。' };
  let comments;
  if (config.provider === 'x-grok') {
    const requestId = crypto.randomUUID();
    const resultPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pendingLibraryAi.delete(requestId); reject(new Error('grok_timeout')); }, 90_000);
      pendingLibraryAi.set(requestId, (result) => {
        clearTimeout(timer); pendingLibraryAi.delete(requestId);
        if (result?.error) reject(new Error(result.error)); else resolve(result?.comments || []);
      });
    });
    await broadcastLibraryCommand({ type: 'XVM_LIBRARY_AI_COMMAND', request: { requestId, text: corpus } });
    comments = await resultPromise;
  } else {
    comments = config.provider === 'ollama'
      ? await generateWithOllama({ ...config, replyCount: 8 }, aiPayload)
      : await generateWithOpenAICompatible({ ...config, replyCount: 8 }, aiPayload);
  }
  const names = parseAiCategories(comments);
  const tags = [];
  for (const name of names) tags.push(await XvmLibraryDb.createTag(name, '#654fe8'));
  for (let index = 0; index < rows.length; index += 1) {
    const tag = tags[index % Math.max(1, tags.length)];
    if (tag) await XvmLibraryDb.assignTag([rows[index].itemId], tag.id);
  }
  return { ok: true, tags, assigned: rows.length };
}

async function handleLibraryRequest(message) {
  if (message.type === 'XVM_LIBRARY_STATUS') return libraryStatus();
  if (message.type === 'XVM_LIBRARY_QUERY') {
    const context = await libraryContext();
    return { ok: true, ...(await XvmLibraryDb.query({ ...(message.query || {}), limit: Math.min(50, Number(message.query?.limit) || 50) }, { isPro: context.isPro })) };
  }
  if (message.type === 'XVM_LIBRARY_FACETS') {
    const context = await libraryContext();
    return { ok: true, ...(await XvmLibraryDb.facets({ isPro: context.isPro })) };
  }
  if (message.type === 'XVM_LIBRARY_RELATIONSHIPS') return relationshipStatus();
  if (message.type === 'XVM_LIBRARY_RELATIONSHIPS_SCAN') {
    return startRelationshipScan(message.payload?.kinds || ['following', 'followers']);
  }
  if (message.type === 'XVM_LIBRARY_RELATIONSHIPS_SYNC') return syncRelationshipCloud();
  if (message.type === 'XVM_LIBRARY_MUTATE') return libraryMutate(message.payload || {});
  if (message.type === 'XVM_LIBRARY_SYNC_START') return startLibrarySync(message.payload || {});
  if (message.type === 'XVM_LIBRARY_SYNC_PAUSE') return pauseLibrarySync();
  if (message.type === 'XVM_LIBRARY_CLOUD_PULL') return { ok: true, ...(await pullLibraryCloud()) };
  if (message.type === 'XVM_LIBRARY_CLOUD_PUSH') return { ok: true, ...(await pushLibraryCloud()) };
  if (message.type === 'XVM_LIBRARY_CLOUD_DELETE') {
    const result = await cloudRequest('/api/library/sync', { method: 'DELETE' });
    const context = await libraryContext();
    await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: { ...context.sync, cloudBackup: false, cloudCursor: 0, cloudDeletedAt: Date.now(), readOnly: false, updatedAt: Date.now() } });
    return result;
  }
  if (message.type === 'XVM_LIBRARY_EXPORT') {
    const context = await libraryContext();
    if (message.query?.cursor && !context.isPro) throw new Error('membership_required');
    return { ok: true, format: message.format || 'json', ...(await XvmLibraryDb.query({ ...(message.query || {}), limit: 50 }, { isPro: context.isPro })) };
  }
  if (message.type === 'XVM_LIBRARY_X_ACTION') return runLibraryXAction(message.payload || {});
  if (message.type === 'XVM_LIBRARY_AI_CLASSIFY') return classifyLibrary(message.payload || {});
  throw new Error('unsupported_message');
}

function isOfficialWebsiteSender(sender) {
  try {
    const url = new URL(sender?.url || '');
    return url.origin === WEBSITE_ORIGIN
      || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname));
  }
  catch (_) { return false; }
}

// The website receives this compact projection only after its origin has been
// checked by Chrome. Raw X responses, cookies and extension bearer tokens never
// leave the extension process.
function makeWebsiteDashboardSnapshot(items = {}) {
  const folderNames = new Map((Array.isArray(items?.bookmarkFoldersCache?.folders)
    ? items.bookmarkFoldersCache.folders : [])
    .map((folder) => [String(folder?.id || ''), String(folder?.name || '')]));
  const records = items?.bookmarkTimelineCache?.folders || {};
  const folders = Object.keys(records).map((id) => ({
    id,
    name: folderNames.get(id) || `未分类 ${id.slice(-4)}`,
  }));
  const rows = [];
  folders.forEach((folder) => {
    const entries = Array.isArray(records?.[folder.id]?.entries) ? records[folder.id].entries : [];
    entries.slice(0, 120).forEach((entry, index) => {
      const result = entry?.content?.itemContent?.tweet_results?.result || {};
      const tweet = result?.tweet || result?.legacy || result;
      const legacy = tweet?.legacy || result?.legacy || {};
      const user = result?.core?.user_results?.result || tweet?.core?.user_results?.result || {};
      const userLegacy = user?.legacy || {};
      const media = legacy?.extended_entities?.media || legacy?.entities?.media || [];
      rows.push({
        id: String(result?.rest_id || tweet?.rest_id || entry?.entryId || `${folder.id}-${index}`),
        folderId: folder.id,
        folderName: folder.name,
        name: String(userLegacy.name || 'X 用户'),
        handle: userLegacy.screen_name ? `@${userLegacy.screen_name}` : '@x_user',
        avatar: String(userLegacy.profile_image_url_https || ''),
        text: String(legacy.full_text || legacy.text || '这条书签的内容正在等待同步。'),
        views: Number(result?.views?.count || legacy?.view_count || 0),
        engagement: Number(legacy.favorite_count || 0) + Number(legacy.retweet_count || 0) + Number(legacy.reply_count || 0),
        media: media.map((item) => item?.media_url_https || item?.media_url).filter(Boolean).slice(0, 3),
      });
    });
  });
  return {
    folders,
    rows: rows.slice(0, 300),
    refreshedAt: Math.max(0, ...Object.values(records).map((record) => Number(record?.refreshedAt) || 0)),
  };
}

async function exchangeExtensionHandoff(code) {
  if (!/^[a-f0-9]{64}$/.test(String(code || ''))) throw new Error('invalid_handoff');
  const res = await fetch(`${AUTH_BACKEND_URL}/api/extension-handoff/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, extensionId: chrome.runtime.id }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok || !data?.token || !data?.user?.id) throw new Error(data?.error || 'handoff_exchange_failed');
  await chrome.storage.local.set({
    [SESSION_KEY]: { token: data.token, userId: data.user.id, email: data.user.email || null, name: data.user.name || null, signedInAt: Date.now() },
    [SUBSCRIPTION_KEY]: { ...(data.subscription || {}), checkedAt: Date.now() },
  });
  try { await chrome.tabs.create({ url: `${WEBSITE_ORIGIN}/workspace` }); } catch (_) {}
  return { user: data.user, subscription: data.subscription || null };
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeProvider(value) {
  return ['x-grok', 'ollama', 'openai-compatible'].includes(value) ? value : DEFAULT_PROVIDER;
}

function normalizeReplyCount(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_REPLY_COUNT;
  return Math.max(1, Math.min(20, n));
}

function getPlatformPreset(platform) {
  return OPENAI_COMPAT_PLATFORMS[platform] || OPENAI_COMPAT_PLATFORMS[DEFAULT_PLATFORM];
}

function normalizeConfig(syncItems, localItems = {}) {
  const provider = normalizeProvider(syncItems?.aiProvider);
  const platform = OPENAI_COMPAT_PLATFORMS[syncItems?.aiOpenAIPlatform]
    ? syncItems.aiOpenAIPlatform
    : DEFAULT_PLATFORM;
  const preset = getPlatformPreset(platform);
  const baseUrl = trimTrailingSlash(syncItems?.aiBaseUrl || preset.baseUrl);
  const model = String(syncItems?.aiModel || preset.model || '').trim();
  return {
    provider,
    platform,
    baseUrl,
    model,
    replyCount: normalizeReplyCount(syncItems?.aiReplyCount),
    language: ['auto', 'zh_CN', 'en', 'ja'].includes(syncItems?.aiLanguage) ? syncItems.aiLanguage : 'auto',
    apiKey: String(localItems?.xvmAiApiKey || '').trim(),
  };
}

function isLocalHttpUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch (_) {
    return false;
  }
}

function assertAllowedOpenAIBaseUrl(baseUrl) {
  const normalized = trimTrailingSlash(baseUrl);
  if (ALLOWED_OPENAI_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    return normalized;
  }
  if (isLocalHttpUrl(normalized) && normalized.endsWith('/v1')) return normalized;
  throw new Error('暂不支持这个 Base URL。请使用内置平台预设，或本地 OpenAI-compatible 地址（localhost/127.0.0.1）。');
}

function assertAllowedOllamaBaseUrl(baseUrl) {
  const normalized = trimTrailingSlash(baseUrl || 'http://localhost:11434');
  if (!isLocalHttpUrl(normalized)) {
    throw new Error('Ollama Base URL 仅支持本机地址 localhost / 127.0.0.1。');
  }
  return normalized.replace(/\/v1$/, '');
}

function renderPrompt(tweetText, templateText, replyCount) {
  const text = String(tweetText || '').trim();
  const tpl = String(templateText || '').trim();
  const rendered = tpl
    ? (tpl.includes(PLACEHOLDER) ? tpl.split(PLACEHOLDER).join(text) : `${text}\n\n${tpl}`)
    : `${text}\n\nGenerate ${replyCount} natural replies. Output only ready-to-post reply text, each inside its own code block.`;
  return `${rendered}\n\n请只输出可直接发布的评论候选，优先使用代码块分隔。最多返回 ${replyCount} 条。`;
}

function extractComments(rawText, limit = DEFAULT_REPLY_COUNT) {
  const text = String(rawText || '').trim();
  if (!text) return [];
  const dedupe = (arr) => Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean))).slice(0, limit);
  const splitLooseCandidates = (value, minItems = 3) => {
    const body = String(value || '').trim();
    if (!body) return [];
    if (/^\s*(?:\d+[\).]|[-*])\s+/m.test(body)) {
      const items = body.split(/\n+(?=\s*(?:\d+[\).]|[-*])\s+)/)
        .map((s) => s.replace(/^\s*(?:\d+[\).]|[-*])\s+/, '').trim())
        .filter((s) => s.length >= 2 && s.length <= 1000);
      if (items.length >= minItems) return items;
    }
    const lines = body.split(/\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && s.length <= 1000);
    return lines.length >= minItems ? lines : [];
  };

  const codeBlocks = [];
  const blockRe = /```(?:[\w-]+)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = blockRe.exec(text))) {
    const c = match[1].trim();
    if (c) codeBlocks.push(c);
  }
  if (codeBlocks.length) {
    if (codeBlocks.length === 1) {
      const split = splitLooseCandidates(codeBlocks[0], 3);
      if (split.length) return dedupe(split);
    }
    return dedupe(codeBlocks);
  }

  if (/^\s*(?:\d+[\).]|[-*])\s+/m.test(text)) {
    const items = splitLooseCandidates(text, 1);
    if (items.length) return dedupe(items);
  }

  return dedupe(splitLooseCandidates(text, 2));
}

async function readErrorText(res) {
  try {
    const text = await res.text();
    return text ? text.slice(0, 300) : '';
  } catch (_) {
    return '';
  }
}

function mapHttpError(status, providerLabel, detail = '') {
  if (status === 401 || status === 403) return `${providerLabel} API Key 无效或没有权限`;
  if (status === 404) return `${providerLabel} 模型或接口不存在，请检查 Base URL 和 Model`;
  if (status === 429) return `${providerLabel} 触发限流，请稍后再试`;
  if (status >= 500) return `${providerLabel} 服务端错误：${status}`;
  return `${providerLabel} 请求失败：${status}${detail ? ` ${detail}` : ''}`;
}

async function fetchJson(url, options, providerLabel) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(mapHttpError(res.status, providerLabel, await readErrorText(res)));
    return await res.json();
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`${providerLabel} 请求超时`);
    if (err instanceof TypeError) throw new Error(`${providerLabel} 无法连接，请检查服务是否启动或网络是否可用`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextStream(url, options, providerLabel, onChunk) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 65000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(mapHttpError(res.status, providerLabel, await readErrorText(res)));
    const reader = res.body?.getReader?.();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) {
        full += chunk;
        onChunk?.(chunk, full);
      }
    }
    const tail = decoder.decode();
    if (tail) {
      full += tail;
      onChunk?.(tail, full);
    }
    return full;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`${providerLabel} 请求超时`);
    if (err instanceof TypeError) throw new Error(`${providerLabel} 无法连接，请检查服务是否启动或网络是否可用`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function emitParsedProgress(rawText, limit, onProgress, state) {
  if (typeof onProgress !== 'function') return;
  const comments = extractComments(rawText, limit);
  if (!comments.length) return;
  const sig = comments.join('\n---\n');
  if (sig === state.lastProgressSig) return;
  state.lastProgressSig = sig;
  onProgress(comments);
}

async function loadConfig() {
  const syncItems = await chrome.storage.sync.get(SYNC_DEFAULTS);
  const localItems = await chrome.storage.local.get(LOCAL_DEFAULTS);
  return normalizeConfig(syncItems, localItems);
}

async function generateWithOllama(config, payload, onProgress) {
  const baseUrl = assertAllowedOllamaBaseUrl(config.baseUrl || 'http://localhost:11434');
  const model = config.model || 'llama3.1';
  const prompt = renderPrompt(payload.tweetText, payload.promptTemplate, config.replyCount);
  let generated = '';
  let pending = '';
  const progressState = { lastProgressSig: '' };
  const processOllamaLine = (line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    try {
      const json = JSON.parse(trimmed);
      generated += json?.message?.content || json?.response || '';
      emitParsedProgress(generated, config.replyCount, onProgress, progressState);
    } catch (_) {}
  };
  const streamBody = await fetchTextStream(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0.8 },
    }),
  }, 'Ollama', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      processOllamaLine(line);
    }
  });
  processOllamaLine(pending);
  if (!generated) {
    for (const line of streamBody.split(/\r?\n/)) {
      try {
        const json = JSON.parse(line.trim());
        generated += json?.message?.content || json?.response || '';
      } catch (_) {}
    }
  }
  const text = generated || streamBody;
  const comments = extractComments(text, config.replyCount);
  if (!comments.length) throw new Error('模型返回中没有解析到评论候选');
  return comments;
}

async function generateWithOpenAICompatible(config, payload, onProgress) {
  const baseUrl = assertAllowedOpenAIBaseUrl(config.baseUrl);
  const model = config.model;
  if (!model) throw new Error('请先填写模型名称');
  if (!config.apiKey && !isLocalHttpUrl(baseUrl)) throw new Error('请先填写 API Key');
  const prompt = renderPrompt(payload.tweetText, payload.promptTemplate, config.replyCount);
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  if (config.platform === 'openrouter') {
    headers['x-title'] = 'X-Tools';
  }
  let generated = '';
  let pending = '';
  const progressState = { lastProgressSig: '' };
  const processOpenAIEvent = (event) => {
    for (const line of String(event || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        generated += json?.choices?.[0]?.delta?.content || json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || '';
        emitParsedProgress(generated, config.replyCount, onProgress, progressState);
      } catch (_) {}
    }
  };
  const streamBody = await fetchTextStream(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.8,
      messages: [{ role: 'user', content: prompt }],
    }),
  }, getPlatformPreset(config.platform).label || 'AI Provider', (chunk) => {
    pending += chunk;
    const events = pending.split(/\r?\n\r?\n+/);
    pending = events.pop() || '';
    for (const event of events) {
      processOpenAIEvent(event);
    }
  });
  processOpenAIEvent(pending);
  if (!generated) {
    try {
      const json = JSON.parse(streamBody);
      generated = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || '';
    } catch (_) {}
  }
  const text = generated || streamBody;
  const comments = extractComments(text, config.replyCount);
  if (!comments.length) throw new Error('模型返回中没有解析到评论候选');
  return comments;
}

async function testOllama(config) {
  const baseUrl = assertAllowedOllamaBaseUrl(config.baseUrl || 'http://localhost:11434');
  const json = await fetchJson(`${baseUrl}/api/tags`, { method: 'GET' }, 'Ollama');
  const models = Array.isArray(json?.models) ? json.models : [];
  const model = config.model || 'llama3.1';
  if (models.length && model && !models.some((m) => m?.name === model || m?.model === model)) {
    return { ok: true, message: `Ollama 已连接，但未在本地模型列表中找到 ${model}` };
  }
  return { ok: true, message: 'Ollama 已连接' };
}

async function testOpenAICompatible(config) {
  const baseUrl = assertAllowedOpenAIBaseUrl(config.baseUrl);
  if (!config.apiKey && !isLocalHttpUrl(baseUrl)) throw new Error('请先填写 API Key');
  const headers = {};
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  await fetchJson(`${baseUrl}/models`, { method: 'GET', headers }, getPlatformPreset(config.platform).label || 'AI Provider');
  return { ok: true, message: '连接测试通过' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'XVM_LIBRARY_CAPTURE_BATCH') {
    (async () => {
      const bound = await ensureLibraryBinding(message.accountId);
      await migrateLegacyBookmarks(bound);
      const deviceId = await ensureDeviceId();
      const records = (message.records || []).map((record) => ({ ...record, accountId: bound, deviceId }));
      const result = await XvmLibraryDb.putCaptures(records);
      const context = await libraryContext();
      const backgroundRunning = context.sync?.background && ['running', 'rate_limited', 'network_retry', 'http_retry'].includes(context.sync?.status);
      const sync = {
        ...context.sync,
        ...(backgroundRunning ? {} : { status: 'idle', lastSyncedAt: Date.now() }),
        lastCapturedAt: Date.now(),
        updatedAt: Date.now(),
        lastOperation: message.operation,
      };
      await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: sync });
      if (context.sync?.cloudBackup && context.isPro) setTimeout(() => pushLibraryCloud().catch(() => {}), 200);
      sendResponse({ ok: true, ...result });
    })().catch((error) => sendResponse(libraryError(error)));
    return true;
  }
  if (message.type === 'XVM_LIBRARY_SOURCE_REMOVED') {
    ensureLibraryBinding(message.accountId)
      .then((bound) => XvmLibraryDb.markSourceRemoved(bound, message.kind, message.postId))
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse(libraryError(error)));
    return true;
  }
  if (message.type === 'XVM_LIBRARY_TEMPLATE') {
    chrome.storage.local.set({ [`xvm_library_template_${message.template?.operation}`]: message.template || null }, () => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'XVM_LIBRARY_AUTH') {
    (async () => {
      const accountId = await ensureLibraryBinding(message.accountId);
      const authorization = String(message.auth?.authorization || '');
      const csrfToken = String(message.auth?.csrfToken || '');
      if (!authorization || !csrfToken) throw new Error('x_auth_required');
      await chrome.storage.session.set({ [LIBRARY_AUTH_KEY]: {
        accountId, authorization, csrfToken, capturedAt: Number(message.auth?.capturedAt || Date.now()),
      } });
      sendResponse({ ok: true });
      setTimeout(() => maybeStartAutoLibrarySync().catch(() => {}), 250);
    })().catch((error) => sendResponse(libraryError(error)));
    return true;
  }
  if (message.type === 'XVM_LIBRARY_PAGE_READY') {
    (async () => {
      const bound = await ensureLibraryBinding(message.accountId);
      await migrateLegacyBookmarks(bound);
      setTimeout(() => maybeStartAutoLibrarySync().catch(() => {}), 500);
      sendResponse({ ok: true });
    })().catch((error) => sendResponse(libraryError(error)));
    return true;
  }
  if (message.type === 'XVM_LIBRARY_SYNC_PROGRESS' || message.type === 'XVM_LIBRARY_SYNC_COMPLETE' || message.type === 'XVM_LIBRARY_ERROR') {
    (async () => {
      const context = await libraryContext();
      if (context.sync?.background && context.sync?.jobId) { sendResponse({ ok: true, ignored: 'background_sync_active' }); return; }
      const status = message.type === 'XVM_LIBRARY_SYNC_COMPLETE' ? 'idle' : (message.type === 'XVM_LIBRARY_ERROR' ? 'failed' : message.status || 'running');
      const operation = message.operation || 'all';
      const sync = {
        ...context.sync, status, updatedAt: Date.now(), error: message.error || null,
        operations: message.type === 'XVM_LIBRARY_SYNC_COMPLETE' ? (context.sync?.operations || {}) : { ...(context.sync?.operations || {}), [operation]: { status, pages: message.pages || 0, captured: message.captured || 0, cursor: message.cursor || '', highWaterId: message.highWaterId || context.sync?.operations?.[operation]?.highWaterId || '', reachedHighWater: Boolean(message.reachedHighWater), updatedAt: Date.now() } },
      };
      if (status === 'idle') sync.lastSyncedAt = Date.now();
      await chrome.storage.local.set({ [LIBRARY_SYNC_KEY]: sync });
      sendResponse({ ok: true });
    })().catch((error) => sendResponse(libraryError(error)));
    return true;
  }
  if (message.type === 'XVM_LIBRARY_X_ACTION_RESULT') {
    const resolver = pendingLibraryActions.get(message.requestId);
    if (resolver) { pendingLibraryActions.delete(message.requestId); resolver(message.results || { error: message.error }); }
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'XVM_LIBRARY_AI_RESULT') {
    const resolver = pendingLibraryAi.get(message.requestId);
    if (resolver) resolver(message);
    sendResponse({ ok: true });
    return false;
  }
  if (message.type.startsWith('XVM_LIBRARY_')) {
    handleLibraryRequest(message).then(sendResponse).catch((error) => sendResponse(libraryError(error)));
    return true;
  }

  if (message.type === 'XVM_AI_GET_PRESETS') {
    sendResponse({ ok: true, presets: OPENAI_COMPAT_PLATFORMS, defaults: SYNC_DEFAULTS });
    return false;
  }

  if (message.type === 'XVM_AI_GENERATE') {
    (async () => {
      const config = await loadConfig();
      const requestId = typeof message.requestId === 'string' ? message.requestId : '';
      const emitProgress = (comments) => {
        if (!requestId || !sender?.tab?.id || !Array.isArray(comments)) return;
        try {
          chrome.tabs?.sendMessage?.(sender.tab.id, {
            type: 'XVM_AI_GENERATE_PROGRESS',
            requestId,
            comments,
          });
        } catch (_) {}
      };
      if (config.provider === 'ollama') {
        sendResponse({ ok: true, comments: await generateWithOllama(config, message.payload || {}, emitProgress) });
        return;
      }
      if (config.provider === 'openai-compatible') {
        sendResponse({ ok: true, comments: await generateWithOpenAICompatible(config, message.payload || {}, emitProgress) });
        return;
      }
      sendResponse({ ok: false, error: '当前 Provider 使用 X Grok，请走页面内 Grok 生成路径' });
    })().catch((err) => sendResponse({ ok: false, error: err?.message || 'AI 生成失败' }));
    return true;
  }

  if (message.type === 'XVM_AI_TEST_CONNECTION') {
    (async () => {
      const config = await loadConfig();
      if (config.provider === 'x-grok') {
        sendResponse({ ok: true, message: 'X Grok 使用当前 X 登录态，无需 API Key' });
        return;
      }
      const result = config.provider === 'ollama'
        ? await testOllama(config)
        : await testOpenAICompatible(config);
      sendResponse(result);
    })().catch((err) => sendResponse({ ok: false, error: err?.message || '连接测试失败' }));
    return true;
  }

  return false;
});

chrome.runtime.onInstalled?.addListener(() => ensureLibraryAutoSyncAlarm());
chrome.runtime.onStartup?.addListener(() => {
  ensureLibraryAutoSyncAlarm();
  maybeStartAutoLibrarySync().catch(() => {});
});
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name !== LIBRARY_AUTO_SYNC_ALARM) return;
  maybeStartAutoLibrarySync().catch(() => {});
});
ensureLibraryAutoSyncAlarm();

// Only the first-party website may ask this extension to redeem a one-time
// handoff code. The raw bearer token remains inside the extension worker.
chrome.runtime.onMessageExternal?.addListener((message, sender, sendResponse) => {
  if (message?.type?.startsWith('XVM_LIBRARY_')) {
    if (!isOfficialWebsiteSender(sender)) {
      sendResponse({ ok: false, error: 'unauthorized' });
      return false;
    }
    handleLibraryRequest(message).then(sendResponse).catch((error) => sendResponse(libraryError(error)));
    return true;
  }
  if (message?.type === 'XVM_WEBSITE_AUTH_PROBE') {
    if (!isOfficialWebsiteSender(sender)) {
      sendResponse({ ok: false, error: 'untrusted_sender' });
      return false;
    }
    chrome.storage.local.get(SESSION_KEY, (items) => {
      sendResponse({ ok: true, extensionId: chrome.runtime.id, email: items?.[SESSION_KEY]?.email || null });
    });
    return true;
  }
  if (message?.type === 'XVM_WEBSITE_AUTH_SIGN_OUT') {
    if (!isOfficialWebsiteSender(sender)) {
      sendResponse({ ok: false, error: 'untrusted_sender' });
      return false;
    }
    chrome.storage.local.remove([SESSION_KEY, SUBSCRIPTION_KEY], () => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'XVM_WEBSITE_AUTH_OPEN_WORKSPACE') {
    if (!isOfficialWebsiteSender(sender)) {
      sendResponse({ ok: false, error: 'untrusted_sender' });
      return false;
    }
    chrome.storage.local.get(SESSION_KEY, (items) => {
      if (!items?.[SESSION_KEY]?.token) {
        sendResponse({ ok: false, error: 'not_signed_in' });
        return;
      }
      chrome.tabs.create({ url: `${WEBSITE_ORIGIN}/workspace` })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    });
    return true;
  }
  if (message?.type === 'XVM_WEBSITE_DASHBOARD_SNAPSHOT') {
    if (!isOfficialWebsiteSender(sender)) {
      sendResponse({ ok: false, error: 'untrusted_sender' });
      return false;
    }
    chrome.storage.local.get(['bookmarkTimelineCache', 'bookmarkFoldersCache'], (items) => {
      sendResponse({ ok: true, snapshot: makeWebsiteDashboardSnapshot(items) });
    });
    return true;
  }
  if (message?.type !== 'XVM_WEBSITE_AUTH_HANDOFF') return false;
  if (!isOfficialWebsiteSender(sender)) {
    sendResponse({ ok: false, error: 'untrusted_sender' });
    return false;
  }
  exchangeExtensionHandoff(message.code)
    .then(({ user, subscription }) => sendResponse({ ok: true, email: user.email || null, subscription }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
