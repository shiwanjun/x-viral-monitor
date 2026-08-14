import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/library-db.js', import.meta.url), 'utf8');
let activeDb;

function loadDb() {
  const crypto = globalThis.crypto;
  const sandbox = { indexedDB, IDBKeyRange, crypto, TextEncoder, console, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'library-db.js' });
  activeDb = sandbox.XvmLibraryDb;
  return activeDb;
}

async function deleteDb() {
  await new Promise((resolve) => { const request = indexedDB.deleteDatabase('x-tools-library'); request.onsuccess = request.onerror = request.onblocked = resolve; });
}

describe('数据中心 IndexedDB', () => {
  beforeEach(deleteDb);
  afterEach(async () => { await activeDb?.close(); activeDb = null; await deleteDb(); });

  it('同一推文可同时属于书签和点赞且不会重复', async () => {
    const db = loadDb();
    const base = { accountId: '1', post: { id: '100', text: 'hello', authorHandle: 'tester', createdAt: 1000 } };
    await db.putCaptures([{ ...base, kind: 'bookmark' }, { ...base, kind: 'like' }, { ...base, kind: 'bookmark' }]);
    const result = await db.query({ limit: 50 }, { isPro: false });
    expect(result.total).toBe(2);
    expect(result.rows.map((row) => row.item.kind).sort()).toEqual(['bookmark', 'like']);
  });

  it('较贫乏的后续响应不会清空标题、正文、媒体和互动指标', async () => {
    const db = loadDb();
    await db.putCapture({ accountId: '1', kind: 'bookmark', post: { id: 'rich', title: '完整标题', text: '这是一段完整得多的正文', authorName: '作者', authorHandle: 'author', media: [{ type: 'image', url: 'cover.jpg' }], metrics: { views: 1000, likes: 50, reposts: 20, replies: 10 } } });
    await db.putCapture({ accountId: '1', kind: 'like', post: { id: 'rich', text: '短文', metrics: { views: 0, likes: 1 } } });
    const result = await db.query({ limit: 50 }, { isPro: true });
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.post.title).toBe('完整标题');
      expect(row.post.text).toBe('这是一段完整得多的正文');
      expect(row.post.media[0].url).toBe('cover.jpg');
      expect(row.post.metrics.views).toBe(1000);
      expect(row.post.metrics.likes).toBe(50);
    }
  });

  it('分页强制不超过 50 条并执行 Free 1K 额度', async () => {
    const db = loadDb();
    const now = Date.now();
    const records = Array.from({ length: 1100 }, (_, index) => ({ accountId: '1', kind: 'bookmark', post: { id: String(index), text: `post-${index}`, authorHandle: 'tester', createdAt: now - index } }));
    for (let offset = 0; offset < records.length; offset += 500) await db.putCaptures(records.slice(offset, offset + 500));
    const result = await db.query({ limit: 999 }, { isPro: false });
    expect(result.rows).toHaveLength(50);
    expect(result.quota.used).toBe(1100);
    expect(result.quota.locked).toBe(100);
  }, 30_000);

  it('归档保留快照且可恢复', async () => {
    const db = loadDb();
    await db.putCapture({ accountId: '1', kind: 'like', post: { id: '7', text: 'archivable' } });
    await db.archive(['1:like:7'], true);
    expect((await db.query({}, {})).quota.used).toBe(1);
    expect((await db.query({}, {})).rows).toHaveLength(0);
    await db.archive(['1:like:7'], false);
    expect((await db.query({}, {})).rows).toHaveLength(1);
  });

  it('云端回放不再次写入 outbox', async () => {
    const db = loadDb();
    const post = db.normalizePost({ id: '9', text: 'cloud' });
    const item = db.normalizeCollection({ accountId: '1', kind: 'authored_post' }, post);
    await db.applyChanges([{ entityType: 'collection', value: { post, item }, updatedAt: item.updatedAt }]);
    expect((await db.query({}, {})).rows).toHaveLength(1);
    expect(await db.readOutbox()).toHaveLength(0);
  });

  it('显式 X 写操作只能作用于匹配的数据类型', async () => {
    const db = loadDb();
    await db.putCaptures([
      { accountId: '1', kind: 'bookmark', post: { id: 'b1', text: '书签' } },
      { accountId: '1', kind: 'like', post: { id: 'l1', text: '点赞' } },
      { accountId: '1', kind: 'authored_reply', post: { id: 'r1', text: '回复' } },
    ]);
    expect((await db.validateXAction('1', 'DeleteBookmark', ['b1'])).valid).toBe(true);
    expect((await db.validateXAction('1', 'DeleteBookmark', ['l1'])).valid).toBe(false);
    expect((await db.validateXAction('1', 'DeleteTweet', ['r1'])).valid).toBe(true);
    expect((await db.validateXAction('2', 'UnfavoriteTweet', ['l1'])).valid).toBe(false);
  });

  it('相同时间戳按 deviceId 稳定解决标签冲突', async () => {
    const db = loadDb();
    const base = { id: 'tag:shared', name: '设备 A', color: '#111111', updatedAt: 2000 };
    await db.applyChanges([{ entityType: 'tags', value: base, updatedAt: 2000, deviceId: 'device-a' }]);
    await db.applyChanges([{ entityType: 'tags', value: { ...base, name: '设备 Z' }, updatedAt: 2000, deviceId: 'device-z' }]);
    await db.applyChanges([{ entityType: 'tags', value: { ...base, name: '旧设备 A' }, updatedAt: 2000, deviceId: 'device-a' }]);
    expect((await db.facets({ isPro: true })).tags.find((tag) => tag.id === base.id).name).toBe('设备 Z');
  });

  it('云端归档变更可在缺少 post 时更新已有快照', async () => {
    const db = loadDb();
    await db.putCapture({ accountId: '1', kind: 'bookmark', post: { id: '55', text: '跨设备归档' } }, { skipOutbox: true });
    const changedAt = Date.now() + 1000;
    await db.applyChanges([{ entityType: 'collection', value: { item: { id: '1:bookmark:55', archivedAt: changedAt, archiveExpiresAt: changedAt + 1000, updatedAt: changedAt } }, updatedAt: changedAt, deviceId: 'device-b' }]);
    expect(await db.listArchived()).toHaveLength(1);
    expect((await db.query({}, { isPro: true })).rows).toHaveLength(0);
  });

  it('10 万条数据库按 50 条游标分页且不丢失', async () => {
    const db = loadDb();
    const batchSize = 500;
    for (let offset = 0; offset < 100_000; offset += batchSize) {
      const records = Array.from({ length: batchSize }, (_, index) => ({ accountId: '1', kind: ['bookmark', 'like', 'authored_post', 'authored_reply'][(offset + index) % 4], post: { id: String(offset + index), text: `性能样本 ${offset + index}`, authorHandle: 'perf', createdAt: 1_000_000 + offset + index } }));
      const result = await db.putCaptures(records, { skipOutbox: true });
      expect(result.accepted).toBe(batchSize);
    }
    const first = await db.query({ limit: 50 }, { isPro: true });
    const last = await db.query({ limit: 50, cursor: '99950' }, { isPro: true });
    expect(first.quota.used).toBe(100_000);
    expect(first.rows).toHaveLength(50);
    expect(first.cursor).toBe('50');
    expect(last.rows).toHaveLength(50);
    expect(last.cursor).toBeNull();
  }, 120_000);
});
