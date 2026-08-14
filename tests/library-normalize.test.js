import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function parser() {
  const source = readFileSync(new URL('../lib/library-normalize.js', import.meta.url), 'utf8');
  const sandbox = { console, Date };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'library-normalize.js' });
  return sandbox.XvmLibraryNormalize;
}

describe('X 数据标准化', () => {
  it('优先保留 Note Tweet 全文、文章标题、媒体与完整互动指标', () => {
    const normalized = parser().normalizeTweet({
      __typename: 'Tweet', rest_id: '900',
      core: { user_results: { result: { rest_id: '1', core: { name: '作者', screen_name: 'author' }, avatar: { image_url: 'avatar.jpg' } } } },
      note_tweet: { note_tweet_results: { result: { text: '这是 Note Tweet 的完整正文' } } },
      article: { article_results: { result: { title: '文章标题', cover_media: { media_info: { original_img_url: 'cover.jpg' } } } } },
      views: { count: '1234' },
      legacy: { full_text: '被截断正文…', created_at: 'Thu Aug 13 10:23:00 +0000 2026', favorite_count: 9, retweet_count: 8, reply_count: 7, bookmark_count: 6, user_id_str: '1' },
    }, 'authored_post', '1');
    expect(normalized.post.title).toBe('文章标题');
    expect(normalized.post.text).toBe('这是 Note Tweet 的完整正文');
    expect(normalized.post.media[0].url).toBe('cover.jpg');
    expect(normalized.post.metrics).toEqual({ views: 1234, likes: 9, reposts: 8, replies: 7, bookmarks: 6 });
  });

  it('兼容 TimelineAddToModule 中的用户与底部游标', () => {
    const api = parser();
    const payload = { data: { instructions: [{ type: 'TimelineAddToModule', moduleItems: [{ item: { itemContent: { user_results: { result: { rest_id: '2', core: { name: 'Alice', screen_name: 'alice' }, legacy: { followers_count: 100, friends_count: 25 } } } } } }] }, { entryId: 'cursor-bottom-1', content: { cursorType: 'Bottom', value: 'next-page' } }] } };
    expect(api.extractUsers(payload)[0]).toMatchObject({ handle: 'alice', fc: 100, fd: 25 });
    expect(api.cursorFrom(payload)).toBe('next-page');
  });
});
