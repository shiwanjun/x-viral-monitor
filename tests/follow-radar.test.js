import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

// Load the pure-logic IIFE with a minimal window stub (node env).
const logicSrc = readFileSync(resolve(repo, 'src/follow-radar/logic.js'), 'utf8');
const radarSrc = readFileSync(resolve(repo, 'src/follow-radar/radar.js'), 'utf8');
const sandbox = { window: {} };
new Function('window', logicSrc)(sandbox.window);
const L = sandbox.window.__xvmFollowRadarLogic;

describe('follow-radar logic', () => {
  describe('首页自动关系查询', () => {
    it('为 UserByScreenName 提供无需先访问个人主页的备用模板', () => {
      expect(radarSrc).toContain("const FALLBACK_USER_BY_SCREEN_NAME_TEMPLATE");
      expect(radarSrc).toContain('authorization: \'Bearer ');
      expect(radarSrc).toMatch(/queryId:\s*'[^']+'/);
      expect(radarSrc).toMatch(/op === ['"]UserByScreenName['"]\s*\?\s*FALLBACK_USER_BY_SCREEN_NAME_TEMPLATE/);
    });

    it('时间线渲染时会将可见作者加入自动刷新队列', () => {
      expect(radarSrc).toContain('scheduleTimelineRefresh(visibleHandles)');
      expect(radarSrc).toContain('const TIMELINE_REFRESH_COOLDOWN_MS');
      expect(radarSrc).toContain('refreshHandles(batch, { automatic: true })');
      expect(radarSrc).toContain("/i/api/1.1/friendships/lookup.json");
      expect(radarSrc).toContain('queueRelationshipLookup(users)');
      expect(radarSrc).toContain("pill: pillFor(h, 'timeline')");
      expect(radarSrc).toContain('authorizationToken(window.__xvmNet?.getBearer?.() || FALLBACK_USER_BY_SCREEN_NAME_TEMPLATE.authorization)');
      expect(radarSrc).toContain('absorbFromCell(cell, article)');
    });

    it('将胶囊插入推文右上角菜单前，并为取关历史增加会员门控', () => {
      expect(radarSrc).toContain("find((node) => node.closest('article[data-testid=\"tweet\"]') === article)");
      expect(radarSrc).toContain('host.insertBefore(pill, anchor)');
      expect(radarSrc).toContain('style.flexDirection === \'row\'');
      expect(radarSrc).toContain('isFollowHistoryMember()');
      expect(radarSrc).toContain('el.style.display = pill ? \'\' : \'none\'');
    });

    it('document_start 时 body 尚未创建也不会让雷达初始化崩溃', () => {
      expect(radarSrc).toContain('const observeRoot = document.body || document.documentElement');
      expect(radarSrc).toContain("document.addEventListener('DOMContentLoaded', startTimelineObserver, { once: true })");
      expect(radarSrc).toContain('timelineObserver.observe(observeRoot');
    });

    it('关系未知时也显示关注率占位，关系确定后始终追加比例', () => {
      expect(radarSrc).toContain("const shortRate = rate == null ? '\\u2014' : String(rate)");
      expect(radarSrc).toContain("const rateLabel = (label) => `${label} ${shortRate}`");
      expect(radarSrc).toContain("if (!settings.rate) return null");
      expect(radarSrc).toContain("label: `${tt('frRate', '关注率')} ${shortRate}`");
    });

    it('会扫描用户卡片页面并复用关系胶囊', () => {
      expect(radarSrc).toContain('querySelectorAll(\'[data-testid="UserCell"]\')');
      expect(radarSrc).toContain('li[role="listitem"]');
      expect(radarSrc).toContain('UserCell cards in the current X build omit User-Name');
      expect(radarSrc).toContain("const match = (link.getAttribute('href') || '').match(/^\\/([A-Za-z0-9_]{1,15})$/)");
      expect(radarSrc).toContain('function applyToUserCards()');
      expect(radarSrc).toContain("pillFor(handle, 'profile')");
      expect(radarSrc).toContain('applyToUserCards();');
      expect(radarSrc).toContain("/i/api/1.1/users/show.json");
      expect(radarSrc).toContain('host.insertBefore(pill, actionButton)');
      expect(radarSrc).toContain('lookupProfileCounts(batch)');
      expect(radarSrc).toContain('关注了你|follows you');
      expect(radarSrc).toContain("const owner = card.closest('[data-testid=\"UserCell\"]') || card");
    });

    it('不再把关系胶囊渲染到流速榜', () => {
      const contentSrc = readFileSync(resolve(repo, 'content.js'), 'utf8');
      expect(contentSrc).toContain('Follow relationship capsules belong to the timeline tweet header');
      expect(contentSrc).not.toContain('pillFor(t.authorHandle, \'leaderboard\')');
    });
  });

  describe('normalizeHandle', () => {
    it('lowercases and strips @', () => {
      expect(L.normalizeHandle('@ElonMusk')).toBe('elonmusk');
      expect(L.normalizeHandle('  Foo_Bar ')).toBe('foo_bar');
    });
    it('rejects invalid handles', () => {
      expect(L.normalizeHandle(null)).toBeNull();
      expect(L.normalizeHandle('')).toBeNull();
      expect(L.normalizeHandle('has space')).toBeNull();
      expect(L.normalizeHandle('too-long-handle-123456')).toBeNull();
      expect(L.normalizeHandle('emoji😀')).toBeNull();
    });
  });

  describe('classify', () => {
    it('mutual when both flags set', () => {
      expect(L.classify({ f: 1, b: 1 })).toBe('mutual');
    });
    it('mine / theirs for one-way links', () => {
      expect(L.classify({ f: 1, b: 0 })).toBe('mine');
      expect(L.classify({ f: 0, b: 1 })).toBe('theirs');
    });
    it('unfollowed only when tombstones exist', () => {
      expect(L.classify({ f: 0, b: 0, u: 123 })).toBe('unfollowed');
      expect(L.classify({ f: 0, b: 0, i: 123 })).toBe('unfollowed');
      expect(L.classify({ f: 0, b: 0 })).toBe('none');
      expect(L.classify(null)).toBe('none');
    });
  });

  describe('computeRate / formatRate', () => {
    it('following ÷ followers with 2 decimals', () => {
      expect(L.computeRate({ fc: 100, fd: 320 })).toBe(3.2);
      expect(L.computeRate({ fc: 1000, fd: 999 })).toBe(1);
      expect(L.computeRate({ fc: 3, fd: 1 })).toBe(0.33);
      expect(L.computeRate({ fc: 100, fd: 95 })).toBe(0.95);
    });
    it('null when followers unknown or zero', () => {
      expect(L.computeRate({ fc: 0, fd: 10 })).toBeNull();
      expect(L.computeRate({})).toBeNull();
      expect(L.computeRate(null)).toBeNull();
    });
    it('formatRate guards null', () => {
      expect(L.formatRate(3.2)).toBe('3.2x');
      expect(L.formatRate(null)).toBe('\u2014');
    });
  });

  describe('mergeUser transitions', () => {
    it('records i_unfollowed when f goes 1→0', () => {
      const { rec, events } = L.mergeUser({ f: 1, b: 0 }, { f: 0, b: 0 }, 1000);
      expect(rec.f).toBe(0);
      expect(rec.i).toBe(1000);
      expect(events).toEqual([{ type: 'i_unfollowed', ts: 1000 }]);
    });
    it('records unfollowed_me when b goes 1→0', () => {
      const { rec, events } = L.mergeUser({ f: 0, b: 1 }, { f: 0, b: 0 }, 2000);
      expect(rec.b).toBe(0);
      expect(rec.u).toBe(2000);
      expect(events).toEqual([{ type: 'unfollowed_me', ts: 2000 }]);
    });
    it('clears tombstone when re-linked', () => {
      const { rec } = L.mergeUser({ f: 0, b: 0, u: 500, i: 600 }, { f: 1, b: 1 }, 3000);
      expect(rec.u).toBeNull();
      expect(rec.i).toBeNull();
      expect(rec.f).toBe(1);
      expect(rec.b).toBe(1);
    });
    it('ignores absent relationship fields (unknown ≠ false)', () => {
      const { rec, events } = L.mergeUser({ f: 1, b: 1 }, { f: undefined, b: undefined, fc: 5 }, 4000);
      expect(rec.f).toBe(1);
      expect(rec.b).toBe(1);
      expect(rec.fc).toBe(5);
      expect(events).toEqual([]);
    });
    it('updates name and counts without events', () => {
      const { rec, events } = L.mergeUser({ f: 1, b: 0 }, { f: 1, b: 0, name: 'New Name', fc: 77, fd: 3 }, 5000);
      expect(rec.n).toBe('New Name');
      expect(rec.fc).toBe(77);
      expect(rec.fd).toBe(3);
      expect(events).toEqual([]);
    });
  });

  describe('diffSnapshots', () => {
    it('detects unfollows in both directions', () => {
      const prev = {
        following: { a: 1, b: 1 },
        followers: { c: 1, b: 1 },
        ts: 100,
      };
      const next = {
        following: { b: 1 }, // a lost → I unfollowed a
        followers: { c: 1 }, // b lost → b unfollowed me
        ts: 200,
      };
      const events = L.diffSnapshots(prev, next);
      expect(events).toContainEqual({ h: 'a', type: 'i_unfollowed', ts: 200 });
      expect(events).toContainEqual({ h: 'b', type: 'unfollowed_me', ts: 200 });
    });
    it('no events when lists unchanged', () => {
      const snap = { following: { a: 1 }, followers: { b: 1 }, ts: 100 };
      expect(L.diffSnapshots(snap, { ...snap, ts: 200 })).toEqual([]);
    });
  });

  describe('extractUsers', () => {
    const legacy = (over) => ({
      screen_name: 'alice',
      name: 'Alice',
      followers_count: 10,
      friends_count: 20,
      ...over,
    });

    it('extracts from direct legacy nodes', () => {
      const users = L.extractUsers({ data: { user: { result: { legacy: legacy({ following: true, followed_by: false }) } } } });
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ handle: 'alice', f: 1, b: 0, fc: 10, fd: 20 });
    });

    it('extracts current X user shape with handle in core', () => {
      const users = L.extractUsers({
        data: {
          user: {
            result: {
              core: { screen_name: 'Alice', name: '新版 Alice' },
              legacy: { followers_count: 10, friends_count: 20 },
              relationship_perspectives: { following: true, followed_by: true },
            },
          },
        },
      });
      expect(users).toEqual([expect.objectContaining({
        handle: 'alice', name: '新版 Alice', f: 1, b: 1, fc: 10, fd: 20,
      })]);
    });

    it('keeps relationship flags when a timeline user omits public counts', () => {
      const users = L.extractUsers({
        data: { user: { result: { legacy: { screen_name: 'alice', following: true, followed_by: false } } } },
      });
      expect(users).toEqual([expect.objectContaining({ handle: 'alice', f: 1, b: 0, fc: undefined, fd: undefined })]);
    });

    it('extracts public metrics counts used by the homepage ratio capsule', () => {
      const users = L.extractUsers({
        result: {
          rest_id: '42',
          core: { screen_name: 'alice' },
          legacy: { public_metrics: { followers_count: 100, following_count: 25 } },
        },
      });
      expect(users[0]).toMatchObject({ handle: 'alice', fc: 100, fd: 25 });
    });

    it('accepts string and camelCase public metrics from newer X payloads', () => {
      const users = L.extractUsers({
        result: {
          core: { screen_name: 'alice' },
          publicMetrics: { followersCount: '200', followingCount: '50' },
        },
      });
      expect(users[0]).toMatchObject({ handle: 'alice', fc: 200, fd: 50 });
    });

    it('merges duplicate user nodes so later counts are not discarded', () => {
      const users = L.extractUsers({
        first: { core: { screen_name: 'alice' }, relationship_perspectives: { following: true, followed_by: true } },
        second: { core: { screen_name: 'alice' }, legacy: { followers_count: 100, friends_count: 25 } },
      });
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ handle: 'alice', f: 1, b: 1, fc: 100, fd: 25 });
    });

    it('extracts from timeline user_results and core wrappers', () => {
      const json = {
        data: {
          timeline: {
            instructions: [{
              entries: [
                { content: { itemContent: { user_results: { result: { legacy: legacy({ screen_name: 'bob' }) } } } } },
              ],
            }],
          },
        },
      };
      const users = L.extractUsers(json);
      expect(users.map((u) => u.handle)).toEqual(['bob']);
    });

    it('does not fabricate relationship flags from absent fields', () => {
      const users = L.extractUsers({ result: { legacy: legacy({}) } });
      expect(users[0].f).toBeUndefined();
      expect(users[0].b).toBeUndefined();
    });

    it('accepts relationship user records whose legacy wrapper is absent', () => {
      const users = L.extractUsers({
        result: {
          core: { screen_name: 'alice', name: 'Alice' },
          relationship_perspectives: { following: true, followed_by: true },
        },
      });
      expect(users[0]).toMatchObject({ handle: 'alice', f: 1, b: 1 });
    });

    it('keeps the X user id for the authenticated relationship lookup fallback', () => {
      const users = L.extractUsers({
        result: {
          rest_id: '42',
          core: { screen_name: 'alice' },
          relationship_perspectives: {},
        },
      });
      expect(users[0]).toMatchObject({ handle: 'alice', id: '42' });
    });

    it('reads relationship flags when X places them directly on the user node', () => {
      const users = L.extractUsers({
        result: {
          rest_id: '42',
          core: { screen_name: 'alice' },
          following: true,
          followed_by: true,
        },
      });
      expect(users[0]).toMatchObject({ handle: 'alice', f: 1, b: 1 });
    });

    it('falls back to legacy.id_str when the modern id is absent', () => {
      const users = L.extractUsers({ result: { core: { screen_name: 'alice' }, legacy: { id_str: '42' } } });
      expect(users[0].id).toBe('42');
    });

    it('dedupes and normalizes handles', () => {
      const users = L.extractUsers({
        a: { legacy: legacy({ screen_name: 'ALICE' }) },
        b: { legacy: legacy({ screen_name: 'alice' }) },
      });
      expect(users).toHaveLength(1);
      expect(users[0].handle).toBe('alice');
    });
  });

  describe('findBottomCursor / findTimelineEntries', () => {
    const payload = {
      data: {
        user: {
          result: {
            timeline: {
              timeline: {
                instructions: [
                  { entries: [
                    { content: { cursorType: 'Top', value: 'top1' } },
                    { content: { itemContent: { user_results: { result: { legacy: { screen_name: 'x', followers_count: 1 } } } } } },
                    { content: { cursorType: 'Bottom', value: 'cur-abc' } },
                  ] },
                ],
              },
            },
          },
        },
      },
    };

    it('finds the last bottom cursor', () => {
      expect(L.findBottomCursor(payload)).toBe('cur-abc');
      expect(L.findBottomCursor({ nope: true })).toBeNull();
    });

    it('locates entries via known path', () => {
      const entries = L.findTimelineEntries(payload);
      expect(entries).toHaveLength(3);
      expect(entries[2].content.cursorType).toBe('Bottom');
    });

    it('falls back to generic entries search', () => {
      const flat = { entries: [{ content: { itemContent: { user_results: { result: {} } } } }] };
      expect(L.findTimelineEntries({ data: { deep: { flat } } })).toHaveLength(1);
    });
  });

  describe('evictUsers', () => {
    it('keeps the newest entries within cap', () => {
      const users = {};
      for (let i = 0; i < 10; i++) users[`u${i}`] = { t: i };
      L.evictUsers(users, 5);
      expect(Object.keys(users)).toHaveLength(5);
      expect(users.u9.t).toBe(9);
      expect(users.u4).toBeUndefined();
    });
    it('no-op under cap', () => {
      const users = { a: { t: 1 }, b: { t: 2 } };
      expect(L.evictUsers(users, 100)).toBe(users);
    });
  });

  describe('userIdFromVariables', () => {
    it('parses numeric userId', () => {
      expect(L.userIdFromVariables('{"userId":"1234567890"}')).toBe('1234567890');
      expect(L.userIdFromVariables('{"userId":"abc"}')).toBeNull();
      expect(L.userIdFromVariables('not json')).toBeNull();
      expect(L.userIdFromVariables(null)).toBeNull();
    });
  });
});
