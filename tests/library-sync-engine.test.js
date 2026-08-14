import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function load(file, name) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const sandbox = { console, setTimeout, clearTimeout, URL, Date, Math };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: name });
  return sandbox;
}

describe('数据中心同步内核', () => {
  it('同时识别 HTTP 429 与 GraphQL code 88 并按重试后成功', async () => {
    const engine = load('../lib/library-sync-engine.js', 'library-sync-engine.js').XvmLibrarySyncEngine;
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null } })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ errors: [{ code: 88 }] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { ok: true } }) });
    const waits = [];
    const result = await engine.fetchPage({ fetchFn, request: { url: 'https://x.com/gql', init: {} }, wait: async (ms) => waits.push(ms) });
    expect(result.payload.data.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(waits).toHaveLength(2);
  });

  it('保存 head 与 backfill 游标并阻止重复游标死循环', () => {
    const engine = load('../lib/library-sync-engine.js', 'library-sync-engine.js').XvmLibrarySyncEngine;
    const initial = engine.initialOperationState({ headId: '100', backfillCursor: 'old-cursor', backfillIncomplete: true }, 'full');
    expect(initial.cursor).toBe('old-cursor');
    const page1 = engine.advanceOperation(initial, { mode: 'full', records: [{ post: { id: '90' } }], cursor: 'c2', inserted: 1 });
    expect(page1.backfillCursor).toBe('c2');
    expect(page1.backfillIncomplete).toBe(true);
    const page2 = engine.advanceOperation(page1, { mode: 'full', records: [{ post: { id: '89' } }], cursor: 'c2' });
    expect(page2.status).toBe('done');
    expect(page2.stopReason).toBe('cursor_loop');
    expect(page2.backfillCursor).toBe('');
  });

  it('增量同步遇到旧 head 后停止并保留本轮新 head', () => {
    const engine = load('../lib/library-sync-engine.js', 'library-sync-engine.js').XvmLibrarySyncEngine;
    const initial = engine.initialOperationState({ headId: '100' }, 'incremental');
    const next = engine.advanceOperation(initial, { mode: 'incremental', records: [{ post: { id: '110' } }, { post: { id: '100' } }], cursor: 'c2' });
    expect(next.status).toBe('done');
    expect(next.stopReason).toBe('head_reached');
    expect(next.headId).toBe('110');
  });
});
