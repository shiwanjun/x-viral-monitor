// X-Tools 数据中心同步内核。
//
// 设计参考：
// - xarchive（MIT）：分页停止条件、HTTP/GraphQL 限流识别与重试；
// - tweetxvault（Apache-2.0）：head/backfill 双游标和逐页检查点。
// 具体实现已按 X-Tools MV3 service worker 与 IndexedDB 契约重写。
((root) => {
  'use strict';

  const BASE_DELAY_MS = 2_600;
  const MAX_RETRIES = 5;
  const MAX_CONSECUTIVE_429 = 5;
  const MAX_CONSECUTIVE_EMPTY = 2;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

  function graphqlError(payload) {
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    if (!errors.length) return null;
    if (errors.some((error) => Number(error?.code) === 88)) return 'rate_limited';
    return 'graphql_error';
  }

  function rateLimitFrom(response) {
    const get = (name) => response?.headers?.get?.(name) || null;
    return {
      limit: get('x-rate-limit-limit'),
      remaining: get('x-rate-limit-remaining'),
      reset: get('x-rate-limit-reset'),
    };
  }

  function waitForRateLimit(rateLimit, attempt, now = Date.now()) {
    const resetAt = Number(rateLimit?.reset || 0) * 1_000;
    if (resetAt > now) return Math.min(15 * 60_000, Math.max(BASE_DELAY_MS, resetAt - now + 1_000));
    return Math.min(60_000, BASE_DELAY_MS * (2 ** Math.max(1, attempt)) + Math.floor(Math.random() * 800));
  }

  async function fetchPage({ fetchFn, request, wait = sleep, onRetry = () => {}, maxRetries = MAX_RETRIES }) {
    if (typeof fetchFn !== 'function') throw new Error('fetch_unavailable');
    let attempt = 0;
    let consecutive429 = 0;
    while (attempt < maxRetries) {
      let response;
      try {
        response = await fetchFn(request.url, request.init);
      } catch (error) {
        attempt += 1;
        if (attempt >= maxRetries) throw new Error(`network_error:${String(error?.message || error)}`);
        const retryMs = Math.min(60_000, BASE_DELAY_MS * (2 ** attempt));
        onRetry({ status: 'network_retry', attempt, retryMs });
        await wait(retryMs);
        continue;
      }

      const rateLimit = rateLimitFrom(response);
      if (response.status === 401 || response.status === 403) throw new Error('x_auth_required');
      if (response.status === 404) throw new Error('query_template_stale');
      if (response.status === 429) {
        attempt += 1;
        consecutive429 += 1;
        if (consecutive429 >= MAX_CONSECUTIVE_429 || attempt >= maxRetries) throw new Error('rate_limited');
        const retryMs = waitForRateLimit(rateLimit, attempt);
        onRetry({ status: 'rate_limited', attempt, retryMs, rateLimit });
        await wait(retryMs);
        continue;
      }
      if (!response.ok) {
        attempt += 1;
        if (attempt >= maxRetries) throw new Error(`x_http_${response.status}`);
        const retryMs = Math.min(60_000, BASE_DELAY_MS * (2 ** attempt));
        onRetry({ status: 'http_retry', attempt, retryMs, httpStatus: response.status });
        await wait(retryMs);
        continue;
      }

      let payload;
      try { payload = await response.json(); }
      catch (_) { throw new Error('invalid_x_response'); }
      const error = graphqlError(payload);
      if (error === 'rate_limited') {
        attempt += 1;
        consecutive429 += 1;
        if (consecutive429 >= MAX_CONSECUTIVE_429 || attempt >= maxRetries) throw new Error('rate_limited');
        const retryMs = waitForRateLimit(rateLimit, attempt);
        onRetry({ status: 'rate_limited', attempt, retryMs, rateLimit });
        await wait(retryMs);
        continue;
      }
      if (error) throw new Error(error);
      return { payload, rateLimit, status: response.status };
    }
    throw new Error('max_retries');
  }

  function initialOperationState(previous = {}, mode = 'incremental') {
    const priorBackfillCursor = String(previous.backfillCursor || previous.cursor || '');
    return {
      status: 'queued',
      pages: 0,
      captured: 0,
      inserted: 0,
      updated: 0,
      headId: String(previous.headId || previous.highWaterId || ''),
      previousHeadId: String(previous.headId || previous.highWaterId || ''),
      cursor: mode === 'full' ? priorBackfillCursor : '',
      backfillCursor: mode === 'full' ? priorBackfillCursor : String(previous.backfillCursor || ''),
      backfillIncomplete: mode === 'full' ? Boolean(priorBackfillCursor || previous.backfillIncomplete) : Boolean(previous.backfillIncomplete),
      consecutiveEmpty: 0,
      seenCursors: [],
      updatedAt: Date.now(),
    };
  }

  function advanceOperation(previous, page) {
    const records = Array.isArray(page.records) ? page.records : [];
    const cursor = String(page.cursor || '');
    const priorCursor = String(previous.cursor || '');
    const previousHeadId = String(previous.previousHeadId || '');
    const reachedHead = Boolean(previousHeadId && records.some((record) => String(record?.post?.id || '') === previousHeadId));
    const consecutiveEmpty = records.length ? 0 : Number(previous.consecutiveEmpty || 0) + 1;
    const cursorLoop = Boolean(cursor && (cursor === priorCursor || (previous.seenCursors || []).includes(cursor)));
    const complete = reachedHead || !cursor || cursorLoop || consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY;
    const firstId = String(records[0]?.post?.id || '');
    const mode = page.mode || 'incremental';
    const next = {
      ...previous,
      status: complete ? 'done' : 'running',
      pages: Number(previous.pages || 0) + 1,
      captured: Number(previous.captured || 0) + records.length,
      inserted: Number(previous.inserted || 0) + Number(page.inserted || 0),
      updated: Number(previous.updated || 0) + Number(page.updated || 0),
      cursor: complete ? '' : cursor,
      headId: firstId && Number(previous.pages || 0) === 0 ? firstId : String(previous.headId || firstId),
      reachedHead,
      stopReason: reachedHead ? 'head_reached' : !cursor ? 'complete' : cursorLoop ? 'cursor_loop' : consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY ? 'empty' : '',
      consecutiveEmpty,
      seenCursors: [...(previous.seenCursors || []), cursor].filter(Boolean).slice(-20),
      updatedAt: Date.now(),
    };
    if (mode === 'full') {
      next.backfillCursor = complete ? '' : cursor;
      next.backfillIncomplete = !complete;
    }
    return next;
  }

  function jitteredDelay(base = BASE_DELAY_MS) {
    return Math.round(base * (0.85 + Math.random() * 0.3));
  }

  root.XvmLibrarySyncEngine = {
    BASE_DELAY_MS,
    MAX_RETRIES,
    MAX_CONSECUTIVE_EMPTY,
    graphqlError,
    rateLimitFrom,
    waitForRateLimit,
    fetchPage,
    initialOperationState,
    advanceOperation,
    jitteredDelay,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
