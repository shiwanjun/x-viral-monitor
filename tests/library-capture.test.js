import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const normalizeSource = readFileSync(new URL('../lib/library-normalize.js', import.meta.url), 'utf8');
const source = readFileSync(new URL('../lib/library-capture.js', import.meta.url), 'utf8');

function tweet(id) {
  return { rest_id: id, legacy: { full_text: `tweet-${id}`, user_id_str: '1', created_at: 'Thu Aug 13 12:00:00 +0000 2026' }, core: { user_results: { result: { rest_id: '1', legacy: { name: 'Me', screen_name: 'me' } } } } };
}

function harness(pages, options = {}) {
  const emitted = [];
  const listeners = new Map();
  const requests = [];
  const net = {
    getBearer: () => 'Bearer live-token',
    onRequest(_pattern, callback) { this.requestCallback = callback; },
    onResponse() {},
    async originalFetch(url, init) {
      requests.push({ url, init });
      const page = pages.shift();
      return { ok: true, status: 200, clone: () => ({ json: async () => page }), json: async () => page };
    },
  };
  const window = {
    __xvmNet: net,
    __xvmGrok: options.grok,
    addEventListener(type, callback) { listeners.set(type, callback); },
    postMessage(message) { emitted.push(message); },
  };
  const sandbox = { window, document: { cookie: 'twid=u%3D1; ct0=csrf-token' }, location: { origin: 'https://x.com', href: 'https://x.com/home' }, URL, Date, Promise, Map, Set, WeakSet, Object, Array, String, Number, JSON, RegExp, setTimeout, clearTimeout, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(normalizeSource, sandbox, { filename: 'library-normalize.js' });
  window.XvmLibraryNormalize = sandbox.XvmLibraryNormalize;
  vm.runInNewContext(source, sandbox, { filename: 'library-capture.js' });
  return { window, net, emitted, requests, send(data) { listeners.get('message')({ source: window, data: { source: 'x-tools-library-isolated', ...data } }); } };
}

async function waitFor(predicate, timeout = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('等待采集器事件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('数据中心 GraphQL 同步器', () => {
  it('增量同步遇到高水位立即停止并使用当前鉴权头', async () => {
    const page = { entries: [{ tweet_results: { result: tweet('new') } }, { tweet_results: { result: tweet('old') } }], cursor: { cursorType: 'Bottom', value: 'next-page' } };
    const app = harness([page]);
    app.send({ type: 'XVM_LIBRARY_SYNC_COMMAND', command: 'start', mode: 'incremental', templates: [{ operation: 'Likes', queryId: 'qid', baseUrl: 'https://x.com/i/api/graphql/qid/Likes', variables: { count: 20 }, highWaterId: 'old' }] });
    await waitFor(() => app.emitted.some((event) => event.type === 'XVM_LIBRARY_SYNC_COMPLETE'));
    const progress = app.emitted.find((event) => event.type === 'XVM_LIBRARY_SYNC_PROGRESS');
    expect(progress.reachedHighWater).toBe(true);
    expect(progress.pages).toBe(1);
    expect(app.requests).toHaveLength(1);
    expect(app.requests[0].init.headers.authorization).toBe('Bearer live-token');
    expect(app.requests[0].init.headers['x-csrf-token']).toBe('csrf-token');
  });

  it('完整同步从保存游标恢复而不是从第一页重来', async () => {
    const app = harness([{ entries: [{ tweet_results: { result: tweet('older') } }] }]);
    app.send({ type: 'XVM_LIBRARY_SYNC_COMMAND', command: 'start', mode: 'full', templates: [{ operation: 'Bookmarks', queryId: 'qid', baseUrl: 'https://x.com/i/api/graphql/qid/Bookmarks', variables: { count: 20 }, resumeCursor: 'resume-123' }] });
    await waitFor(() => app.emitted.some((event) => event.type === 'XVM_LIBRARY_SYNC_COMPLETE'));
    expect(JSON.parse(new URL(app.requests[0].url).searchParams.get('variables')).cursor).toBe('resume-123');
  });

  it('AI 分类可复用 X 页面已有 Grok 通道并回传标签', async () => {
    const calls = [];
    const app = harness([], { grok: { async generate(payload) { calls.push(payload); return ['人工智能', '内容创作']; } } });
    app.send({ type: 'XVM_LIBRARY_AI_COMMAND', request: { requestId: 'ai-1', text: '一组待分类推文' } });
    await waitFor(() => app.emitted.some((event) => event.type === 'XVM_LIBRARY_AI_RESULT'));
    const result = app.emitted.find((event) => event.type === 'XVM_LIBRARY_AI_RESULT');
    expect(result).toMatchObject({ requestId: 'ai-1', comments: ['人工智能', '内容创作'] });
    expect(calls[0].temporaryChat).toBe(true);
    expect(calls[0].tweetText).toBe('一组待分类推文');
  });
});
