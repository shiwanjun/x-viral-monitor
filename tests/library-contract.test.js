import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('数据中心公共契约', () => {
  it('Manifest 启用 IndexedDB 大容量并同时加载隔离桥与主世界采集器', () => {
    const manifest = JSON.parse(read('../manifest.json'));
    expect(manifest.permissions).toContain('unlimitedStorage');
    expect(manifest.content_scripts[0].js).toContain('lib/library-bridge.js');
    expect(manifest.content_scripts[1].js).toContain('lib/library-capture.js');
  });

  it('扩展暴露完整分页消息且单页最多 50 条', () => {
    const background = read('../background.js');
    ['XVM_LIBRARY_STATUS', 'XVM_LIBRARY_QUERY', 'XVM_LIBRARY_FACETS', 'XVM_LIBRARY_MUTATE', 'XVM_LIBRARY_SYNC_START', 'XVM_LIBRARY_SYNC_PAUSE', 'XVM_LIBRARY_EXPORT', 'XVM_LIBRARY_X_ACTION'].forEach((type) => expect(background).toContain(type));
    expect(background).toMatch(/Math\.min\(50,/);
  });

  it('采集器覆盖四种数据和三种显式 X 写操作', () => {
    const capture = read('../lib/library-capture.js');
    ['Bookmarks', 'BookmarkFolderTimeline', 'Likes', 'UserTweetsAndReplies', 'DeleteBookmark', 'UnfavoriteTweet', 'DeleteTweet'].forEach((operation) => expect(capture).toContain(operation));
    expect(capture).toContain('2600');
    expect(capture).toContain('response.status === 429');
  });

  it('Worker 提供 D1/R2 云同步路由与 30 天清理', () => {
    const worker = read('../worker/src/index.ts');
    ['/api/library/sync/status', '/api/library/sync/push', '/api/library/sync/pull', '/api/library/sync'].forEach((route) => expect(worker).toContain(route));
    expect(worker).toContain('CompressionStream("gzip")');
    expect(worker).toContain('30 * 24 * 60 * 60 * 1000');
    expect(read('../worker/auth/schema.sql')).toContain('library_sync_chunks');
  });

  it('工作台包含三视图、额度墙和降级状态', () => {
    const html = read('../docs/workspace.html');
    ['表格', '画廊', '统计', 'quota-wall', '正在连接扩展', '云备份'].forEach((label) => expect(html).toContain(label));
    expect(read('../docs/workspace.js')).toContain("limit: 50");
  });
});
