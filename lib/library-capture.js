// X-Tools 数据中心：在 X 页面主世界被动捕获 GraphQL 数据，并执行显式同步/写操作。
(() => {
  'use strict';
  if (window.__xvmLibraryCaptureLoaded) return;
  window.__xvmLibraryCaptureLoaded = true;

  const GRAPHQL_RE = /\/i\/api\/graphql\/([^/?]+)\/([^/?]+)/;
  const READ_OPERATIONS = new Set(['Bookmarks', 'BookmarkFolderTimeline', 'Likes', 'UserTweets', 'UserTweetsAndReplies']);
  const WRITE_KIND = { DeleteBookmark: 'bookmark', UnfavoriteTweet: 'like', DeleteTweet: 'authored_post' };
  const templates = new Map();
  const activeSyncs = new Map();

  function accountId() {
    const match = document.cookie.match(/(?:^|;\s*)twid=(?:u%3D|u=)?(\d+)/);
    return match?.[1] || '';
  }

  function emit(type, payload = {}) {
    window.postMessage({ source: 'x-tools-library-main', type, ...payload }, location.origin);
  }

  function operationFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      const match = url.pathname.match(GRAPHQL_RE);
      return match ? { queryId: match[1], operation: match[2], url } : null;
    } catch (_) { return null; }
  }

  function variablesFrom(url, init) {
    try {
      const query = url.searchParams.get('variables');
      if (query) return JSON.parse(query);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      return body?.variables || body || {};
    } catch (_) { return {}; }
  }

  function featureParams(url) {
    const keys = ['features', 'fieldToggles'];
    const result = {};
    keys.forEach((key) => { if (url.searchParams.has(key)) result[key] = url.searchParams.get(key); });
    return result;
  }

  function safeHeaders(headers = {}) {
    const allowed = ['authorization', 'x-csrf-token', 'x-twitter-active-user', 'x-twitter-auth-type', 'x-twitter-client-language'];
    const result = {};
    allowed.forEach((name) => { if (headers?.[name]) result[name] = String(headers[name]); });
    return result;
  }

  function rememberTemplate(rawUrl, init, headers) {
    const parsed = operationFromUrl(rawUrl);
    if (!parsed || (!READ_OPERATIONS.has(parsed.operation) && !WRITE_KIND[parsed.operation])) return;
    const template = {
      operation: parsed.operation,
      queryId: parsed.queryId,
      baseUrl: `${parsed.url.origin}${parsed.url.pathname}`,
      variables: variablesFrom(parsed.url, init),
      params: featureParams(parsed.url),
      method: String(init?.method || 'GET').toUpperCase(),
      headers: safeHeaders(headers),
      capturedAt: Date.now(),
    };
    templates.set(parsed.operation, template);
    emit('XVM_LIBRARY_TEMPLATE', { template: { ...template, headers: undefined } });
  }

  function restoreTemplate(template) {
    if (!template?.operation || !template?.queryId || !template?.baseUrl) return false;
    if (!READ_OPERATIONS.has(template.operation) && !WRITE_KIND[template.operation]) return false;
    templates.set(template.operation, { ...template, headers: safeHeaders(template.headers || {}) });
    return true;
  }

  function unwrapTweet(value) {
    let node = value;
    for (let i = 0; i < 5; i += 1) {
      if (!node || typeof node !== 'object') return null;
      if (node.__typename === 'TweetWithVisibilityResults') { node = node.tweet; continue; }
      if (node.tweet_results?.result) { node = node.tweet_results.result; continue; }
      if (node.result?.rest_id && (node.result.legacy || node.result.core)) { node = node.result; continue; }
      break;
    }
    return node?.rest_id && (node.legacy || node.core || node.__typename === 'Tweet') ? node : null;
  }

  function findTweets(root) {
    const found = new Map();
    const seen = new WeakSet();
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 24 || seen.has(node)) return;
      seen.add(node);
      const tweet = unwrapTweet(node);
      if (tweet?.rest_id) { found.set(String(tweet.rest_id), tweet); return; }
      if (Array.isArray(node)) node.forEach((child) => walk(child, depth + 1));
      else Object.values(node).forEach((child) => walk(child, depth + 1));
    };
    walk(root, 0);
    return [...found.values()];
  }

  function cursorFrom(root) {
    let cursor = '';
    const seen = new WeakSet();
    const walk = (node, depth) => {
      if (cursor || !node || typeof node !== 'object' || depth > 18 || seen.has(node)) return;
      seen.add(node);
      if ((node.cursorType === 'Bottom' || String(node.entryId || '').includes('cursor-bottom')) && node.value) cursor = String(node.value);
      if (!cursor && node.content?.value && String(node.entryId || '').includes('cursor-bottom')) cursor = String(node.content.value);
      Object.values(node).forEach((child) => walk(child, depth + 1));
    };
    walk(root, 0);
    return cursor;
  }

  function mediaFrom(legacy) {
    const media = legacy?.extended_entities?.media || legacy?.entities?.media || [];
    return media.slice(0, 8).map((item) => {
      const video = (item?.video_info?.variants || []).filter((v) => v?.url).sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))[0];
      return { type: item?.type || 'image', url: video?.url || item?.media_url_https || item?.media_url || '', previewUrl: item?.media_url_https || item?.media_url || '' };
    }).filter((item) => item.url);
  }

  function normalize(tweet, kind, viewerId) {
    const legacy = tweet?.legacy || {};
    if (legacy.retweeted_status_result || /^RT\s+@/i.test(legacy.full_text || '')) return null;
    const user = tweet?.core?.user_results?.result || {};
    const userLegacy = user?.legacy || {};
    const authorId = String(user?.rest_id || legacy.user_id_str || '');
    if ((kind === 'authored_post' || kind === 'authored_reply') && viewerId && authorId !== viewerId) return null;
    const resolvedKind = kind.startsWith('authored_')
      ? (legacy.in_reply_to_status_id_str ? 'authored_reply' : 'authored_post')
      : kind;
    const created = Date.parse(legacy.created_at || '') || Date.now();
    return {
      accountId: viewerId || 'current',
      kind: resolvedKind,
      capturedAt: Date.now(),
      post: {
        id: String(tweet.rest_id), text: legacy.full_text || legacy.text || '',
        authorId, authorName: userLegacy.name || user?.core?.name || 'X 用户',
        authorHandle: userLegacy.screen_name || user?.core?.screen_name || '',
        authorAvatar: userLegacy.profile_image_url_https || user?.avatar?.image_url || '',
        createdAt: created, conversationId: legacy.conversation_id_str || '',
        inReplyToId: legacy.in_reply_to_status_id_str || '',
        quotedPostId: legacy.quoted_status_id_str || '', media: mediaFrom(legacy),
        metrics: { views: Number(tweet?.views?.count || 0), likes: Number(legacy.favorite_count || 0), reposts: Number(legacy.retweet_count || 0), replies: Number(legacy.reply_count || 0), bookmarks: Number(legacy.bookmark_count || 0) },
        updatedAt: Date.now(),
      },
    };
  }

  function kindForOperation(operation) {
    if (operation === 'Bookmarks' || operation === 'BookmarkFolderTimeline') return 'bookmark';
    if (operation === 'Likes') return 'like';
    return 'authored_post';
  }

  async function captureResponse(rawUrl, response) {
    const parsed = operationFromUrl(rawUrl);
    if (!parsed) return;
    if (READ_OPERATIONS.has(parsed.operation)) {
      let json;
      try { json = await response.clone().json(); } catch (_) { try { json = await response.json(); } catch (_) { return; } }
      const viewerId = accountId();
      const urlVars = variablesFrom(parsed.url, {});
      const requestVars = Object.keys(urlVars).length ? urlVars : (templates.get(parsed.operation)?.variables || {});
      if (parsed.operation.startsWith('UserTweets') && viewerId && requestVars.userId && String(requestVars.userId) !== viewerId) return;
      const records = findTweets(json).map((tweet) => normalize(tweet, kindForOperation(parsed.operation), viewerId)).filter(Boolean);
      emit('XVM_LIBRARY_CAPTURE_BATCH', { accountId: viewerId, operation: parsed.operation, records, cursor: cursorFrom(json) });
      return;
    }
    const kind = WRITE_KIND[parsed.operation];
    if (!kind || Number(response?.status || 200) >= 400) return;
    const vars = Object.keys(variablesFrom(parsed.url, {})).length ? variablesFrom(parsed.url, {}) : (templates.get(parsed.operation)?.variables || {});
    const postId = vars.tweet_id || vars.tweetId || vars.tweet_id_str;
    if (postId) emit('XVM_LIBRARY_SOURCE_REMOVED', { accountId: accountId(), kind, postId: String(postId) });
  }

  function buildReplay(template, cursor) {
    const variables = { ...(template.variables || {}), count: Math.min(100, Number(template.variables?.count || 100)) };
    if (cursor) variables.cursor = cursor; else delete variables.cursor;
    const url = new URL(template.baseUrl);
    url.searchParams.set('variables', JSON.stringify(variables));
    Object.entries(template.params || {}).forEach(([key, value]) => url.searchParams.set(key, value));
    return { url: url.href, init: { method: 'GET', credentials: 'include', headers: template.headers || {} } };
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function syncOperation(operation, mode = 'incremental') {
    const template = templates.get(operation);
    if (!template) throw new Error('missing_query_template');
    const maxPages = mode === 'full' ? 2000 : 5;
    let cursor = '', pages = 0, captured = 0, backoff = 2500;
    activeSyncs.set(operation, true);
    while (activeSyncs.get(operation) && pages < maxPages) {
      const request = buildReplay(template, cursor);
      const response = await window.__xvmNet.originalFetch(request.url, request.init);
      if (response.status === 429) { emit('XVM_LIBRARY_SYNC_PROGRESS', { operation, status: 'rate_limited', pages, retryMs: backoff }); await wait(backoff); backoff = Math.min(60_000, backoff * 2); continue; }
      if (!response.ok) throw new Error(`x_http_${response.status}`);
      const json = await response.clone().json();
      const viewerId = accountId();
      const records = findTweets(json).map((tweet) => normalize(tweet, kindForOperation(operation), viewerId)).filter(Boolean);
      captured += records.length; pages += 1;
      cursor = cursorFrom(json);
      emit('XVM_LIBRARY_CAPTURE_BATCH', { accountId: viewerId, operation, records, cursor });
      emit('XVM_LIBRARY_SYNC_PROGRESS', { operation, status: cursor ? 'running' : 'done', pages, captured, cursor });
      if (!cursor || !records.length) break;
      await wait(2600);
    }
    activeSyncs.delete(operation);
    return { operation, pages, captured, cursor };
  }

  async function runSync(mode, requested) {
    const operations = (requested || [...READ_OPERATIONS]).filter((op) => templates.has(op));
    const results = [];
    for (const operation of operations) results.push(await syncOperation(operation, mode));
    emit('XVM_LIBRARY_SYNC_COMPLETE', { mode, results });
  }

  async function runXAction(action) {
    const operation = action?.operation;
    const template = templates.get(operation);
    if (!template || !WRITE_KIND[operation]) throw new Error('missing_write_template');
    const ids = (Array.isArray(action.postIds) ? action.postIds : []).slice(0, 50);
    const results = [];
    for (const postId of ids) {
      try {
        const url = new URL(template.baseUrl);
        const body = JSON.stringify({ variables: { ...(template.variables || {}), tweet_id: postId }, queryId: template.queryId });
        const response = await window.__xvmNet.originalFetch(url.href, { method: 'POST', credentials: 'include', headers: { ...template.headers, 'content-type': 'application/json' }, body });
        results.push({ postId, ok: response.ok, status: response.status });
      } catch (error) { results.push({ postId, ok: false, error: String(error?.message || error) }); }
      await wait(2600);
    }
    emit('XVM_LIBRARY_X_ACTION_RESULT', { requestId: action.requestId, results });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'x-tools-library-isolated') return;
    if (event.data.type === 'XVM_LIBRARY_SYNC_COMMAND') {
      (event.data.templates || []).forEach(restoreTemplate);
      if (event.data.command === 'pause') activeSyncs.forEach((_, key) => activeSyncs.set(key, false));
      else runSync(event.data.mode || 'incremental', event.data.operations).catch((error) => emit('XVM_LIBRARY_ERROR', { error: String(error?.message || error) }));
    }
    if (event.data.type === 'XVM_LIBRARY_X_ACTION_COMMAND') runXAction(event.data.action).catch((error) => emit('XVM_LIBRARY_X_ACTION_RESULT', { requestId: event.data.action?.requestId, error: String(error?.message || error) }));
  });

  const net = window.__xvmNet;
  if (!net) return;
  net.onRequest(/\/i\/api\/graphql\//, ({ url, init, headers }) => rememberTemplate(url, init, headers));
  net.onResponse(/\/i\/api\/graphql\//, ({ url, response }) => captureResponse(url, response));
  emit('XVM_LIBRARY_PAGE_READY', { accountId: accountId() });
})();
