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
});
