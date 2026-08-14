import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function discovery() {
  const source = readFileSync(new URL('../lib/library-query-discovery.js', import.meta.url), 'utf8');
  const sandbox = { console, URL, fetch: undefined };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'library-query-discovery.js' });
  return sandbox.XvmLibraryQueryDiscovery;
}

describe('X GraphQL Query ID 动态发现', () => {
  it('兼容正向、反向和带引号的压缩对象', () => {
    const api = discovery();
    const result = api.extractQueryIds(`
      {queryId:"bookmark-query-123",operationName:"Bookmarks"}
      {operationName:'Likes',queryId:'likes-query-456'}
      {"queryId":"tweets-query-789","operationName":"UserTweetsAndReplies"}
    `);
    expect(result).toEqual({ Bookmarks: 'bookmark-query-123', Likes: 'likes-query-456', UserTweetsAndReplies: 'tweets-query-789' });
  });

  it('优先返回 X 页面中的客户端 bundle 并去重', () => {
    const api = discovery();
    const urls = api.scriptUrls('<script src="https://abs.twimg.com/a.js"></script><script src="https://abs.twimg.com/client-web/b.js"></script><script src="https://abs.twimg.com/a.js"></script>');
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('client-web');
  });
});
