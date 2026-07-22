import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const source = readFileSync(resolve(repo, 'lib/bookmark-timeline-inject.js'), 'utf8');
const storageSource = readFileSync(resolve(repo, 'lib/bookmark-timeline-storage.js'), 'utf8');
const manifest = JSON.parse(readFileSync(resolve(repo, 'manifest.json'), 'utf8'));
const bridge = readFileSync(resolve(repo, 'bridge.js'), 'utf8');
const content = readFileSync(resolve(repo, 'content.js'), 'utf8');
const styles = readFileSync(resolve(repo, 'styles.css'), 'utf8');

function loadApi() {
  const ctx = { window: {}, globalThis: {}, Date, structuredClone };
  vm.runInNewContext(source, ctx);
  return ctx.window.__xvmBookmarkTimelineInject;
}

function loadStorageApi() {
  const ctx = { globalThis: {}, Date, JSON, TextEncoder, decodeURIComponent, structuredClone };
  vm.runInNewContext(storageSource, ctx);
  return ctx.globalThis.__xvmBookmarkTimelineStorage;
}

function tweetEntry(id) {
  return {
    entryId: `tweet-${id}`,
    sortIndex: String(1000000 - Number(id || 0) * 1000),
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: {
        itemType: 'TimelineTweet',
        tweet_results: {
          result: {
            rest_id: String(id),
            legacy: { full_text: `tweet ${id}` },
          },
        },
      },
    },
  };
}

function homeTimeline(ids) {
  return {
    data: {
      home: {
        home_timeline_urt: {
          instructions: [
            {
              type: 'TimelineAddEntries',
              entries: ids.map(tweetEntry),
            },
          ],
        },
      },
    },
  };
}

describe('bookmark timeline injection', () => {
  it('isolates persisted bookmark entries by the signed-in X account', () => {
    const storageApi = loadStorageApi();
    expect(storageApi.accountIdFromCookie('lang=zh-cn; twid=u%3D123456789')).toBe('123456789');
    expect(storageApi.normalizeCacheDocument({
      accountId: '111',
      folders: { 'folder-a': { entries: [tweetEntry('90')], refreshedAt: Date.now() } },
    }, '222', ['folder-a']).folders).toEqual({});
  });

  it('rejects malformed, oversized, stale, and unselected persisted entries', () => {
    const storageApi = loadStorageApi();
    const now = Date.now();
    const huge = tweetEntry('91');
    huge.content.itemContent.tweet_results.result.legacy.full_text = 'x'.repeat(140 * 1024);
    const normalized = storageApi.normalizeCacheDocument({
      accountId: '123',
      folders: {
        '1000': { entries: [tweetEntry('90'), huge, { hostile: true }], refreshedAt: now },
        '1001': { entries: [tweetEntry('92')], refreshedAt: now - 25 * 60 * 60 * 1000 },
        '1002': { entries: [tweetEntry('93')], refreshedAt: now },
      },
    }, '123', ['1000', '1001'], now);

    expect(Object.keys(normalized.folders)).toEqual(['1000']);
    expect(normalized.folders['1000'].entries.map(storageApi.getTweetId)).toEqual(['90']);
  });

  it('requires the cache owner to match the active X account', () => {
    const storageApi = loadStorageApi();
    expect(storageApi.resolveScope('123', '123', true, ['1000'])).toEqual({
      action: 'use',
      scope: { accountId: '123', folderIds: ['1000'] },
    });
    expect(storageApi.resolveScope('222', '123', true, ['1000']).action).toBe('reset');
    expect(storageApi.resolveScope('123', '123', false, ['1000']).action).toBe('clear');
    expect(storageApi.resolveScope('123', '123', true, []).action).toBe('clear');
  });

  it('deduplicates and bounds selected folder ids', () => {
    const storageApi = loadStorageApi();
    const ids = Array.from({ length: 25 }, (_, index) => String(1000 + index));
    expect(storageApi.sanitizeFolderIds([ids[0], ids[0], 'not-an-id', ...ids])).toEqual(ids.slice(0, 20));
  });

  it('deduplicates and bounds seen bookmark tweet ids per account', () => {
    const storageApi = loadStorageApi();

    expect(storageApi.mergeSeenTweetIds({
      accountId: '123',
      ids: ['90', '91'],
    }, '123', ['91', '92', 'bad'], 3)).toEqual({
      accountId: '123',
      ids: ['90', '91', '92'],
    });
    expect(storageApi.mergeSeenTweetIds({
      accountId: '999',
      ids: ['90'],
    }, '123', ['91'], 3)).toEqual({
      accountId: '123',
      ids: ['91'],
    });
    expect(storageApi.mergeSeenTweetIds({
      accountId: '123',
      ids: ['90', '91', '92'],
    }, '123', ['93'], 3)).toEqual({
      accountId: '123',
      ids: ['91', '92', '93'],
    });
  });

  it('keeps a successful empty folder snapshot as an authoritative cache record', () => {
    const storageApi = loadStorageApi();
    const normalized = storageApi.normalizeCacheDocument({
      accountId: '123',
      folders: { '1000': { entries: [], refreshedAt: Date.now() } },
    }, '123', ['1000']);
    expect(normalized.folders['1000'].entries).toEqual([]);
    expect(content).toContain('bookmarkTimelineEntryCache.delete(folderId);');
  });

  it('publishes only complete, schema-valid folder refreshes', () => {
    expect(bridge).toContain("if (!res.ok) throw new Error(`BookmarkFolderTimeline HTTP ${res.status}`)");
    expect(bridge).toContain("if (!valid) throw new Error('BookmarkFolderTimeline invalid timeline')");
    expect(bridge).toContain('await persistBookmarkTimelineFolder(id, entries, refreshedAt);');
    expect(bridge).toContain('BOOKMARK_TIMELINE_STORAGE_LOCK');
    expect(bridge).toContain('BOOKMARK_TIMELINE_MANUAL_LOCK');
    expect(bridge).toContain('[BOOKMARK_TIMELINE_MANUAL_ATTEMPT_KEY]: { accountId: scope.accountId, at: now }');
  });

  it('loads the helper before content.js in the MAIN-world content script', () => {
    const main = manifest.content_scripts.find((cs) => cs.world === 'MAIN');
    const order = main.js;
    expect(order.indexOf('lib/bookmark-timeline-inject.js')).toBeLessThan(order.indexOf('content.js'));
  });

  it('loads the storage boundary before the isolated bridge', () => {
    const isolated = manifest.content_scripts.find((cs) => !cs.world);
    expect(isolated.js.indexOf('lib/bookmark-timeline-storage.js')).toBeLessThan(isolated.js.indexOf('bridge.js'));
    expect(bridge).not.toContain('XVM_BOOKMARK_TIMELINE_CACHE_PERSIST');
    expect(content).not.toContain('XVM_BOOKMARK_TIMELINE_CACHE_PERSIST');
    expect(bridge).toContain("const BOOKMARK_TIMELINE_SETTINGS_KEY = 'bookmarkTimelineSettings'");
    expect(bridge).toContain("chrome.storage.sync.remove([\n          'featureBookmarkTimelineInject'");
  });

  it('removes legacy synced bookmark settings exactly once on upgrade', () => {
    const start = bridge.indexOf('function removeLegacySyncedBookmarkTimelineSettings(');
    const end = bridge.indexOf('\nfunction readBookmarkTimelineSettings(', start);
    const local = { bookmarkTimelineSyncSettingsRemoved: false };
    const removed = [];
    const chrome = {
      storage: {
        local: {
          get(defaults, callback) { callback({ ...defaults, ...local }); },
          set(values, callback) { Object.assign(local, values); callback?.(); },
        },
        sync: {
          remove(keys, callback) { removed.push(keys); callback(); },
        },
      },
    };
    const migrate = Function(
      'chrome',
      'BOOKMARK_TIMELINE_SYNC_MIGRATED_KEY',
      `${bridge.slice(start, end)}; return removeLegacySyncedBookmarkTimelineSettings;`,
    )(chrome, 'bookmarkTimelineSyncSettingsRemoved');

    migrate();
    migrate();

    expect(removed).toEqual([[
      'featureBookmarkTimelineInject',
      'bookmarkTimelineInjectFolderIds',
      'bookmarkTimelineInjectEvery',
    ]]);
    expect(local.bookmarkTimelineSyncSettingsRemoved).toBe(true);
  });

  it('exposes a bridge message for saving experimental inject settings', () => {
    expect(bridge).toContain('XVM_BOOKMARK_TIMELINE_INJECT_SAVE');
    expect(bridge).toContain('XVM_BOOKMARK_TIMELINE_REFRESH');
    expect(bridge).toContain('XVM_BOOKMARK_TIMELINE_CACHE_UPDATE');
    expect(bridge).toContain('bookmarkTimelineInjectFolderIds');
    expect(bridge).toContain('bookmarkTimelineInjectEvery');
  });

  it('persists enable and folder selection while the other setting is still empty', () => {
    // Given
    const start = bridge.indexOf("  if (type === 'XVM_BOOKMARK_TIMELINE_INJECT_SAVE') {");
    const end = bridge.indexOf("\n  if (type === 'XVM_BOOKMARK_FOLDER_MUTATION'", start);
    const saved = {};
    const cleared = [];
    const chrome = {
      storage: {
        local: {
          set(values, callback) { Object.assign(saved, values); callback?.(); },
        },
        sync: {
          remove(_keys, callback) { callback(); },
          get(defaults, callback) { callback(defaults); },
        },
      },
    };
    const handle = Function(
      'chrome',
      'safeChromeCall',
      'currentBookmarkTimelineAccountId',
      'clearBookmarkTimelineStorage',
      'pruneBookmarkTimelineCache',
      'pushSettings',
      'STORAGE_DEFAULTS',
      'BOOKMARK_TIMELINE_SETTINGS_KEY',
      'globalThis',
      `return function handle(data) { const type = data.type; const event = { data }; ${bridge.slice(start, end)} };`,
    )(
      chrome,
      (callback) => callback(),
      () => '123',
      (callback) => { cleared.push(true); callback?.(); },
      (_scope, callback) => callback?.(),
      () => {},
      {},
      'bookmarkTimelineSettings',
      { __xvmBookmarkTimelineStorage: loadStorageApi() },
    );

    // When / Then: enabling first must stay enabled while no folder is selected yet.
    handle({ type: 'XVM_BOOKMARK_TIMELINE_INJECT_SAVE', enabled: true, folderIds: [], every: 20 });
    expect(saved.bookmarkTimelineSettings).toEqual({
      accountId: '123', enabled: true, folderIds: [], every: 20,
    });

    // When / Then: selecting a folder first must stay selected while disabled.
    handle({ type: 'XVM_BOOKMARK_TIMELINE_INJECT_SAVE', enabled: false, folderIds: ['1000'], every: 20 });
    expect(saved.bookmarkTimelineSettings).toEqual({
      accountId: '123', enabled: false, folderIds: ['1000'], every: 20,
    });
    expect(cleared).toEqual([]);
  });

  it('clears inactive bookmark cache without deleting partial settings', () => {
    // Given
    const start = bridge.indexOf('function clearBookmarkTimelineCache(');
    const end = bridge.indexOf('\nfunction runBookmarkTimelineStorageTask(', start);
    const local = {
      bookmarkTimelineSettings: { accountId: '123', enabled: false, folderIds: ['1000'], every: 20 },
      bookmarkTimelineCache: { accountId: '123', folders: {} },
      bookmarkTimelineAutoAttemptAt: { accountId: '123', folders: {} },
    };
    const chrome = {
      storage: {
        local: {
          get(defaults, callback) { callback({ ...defaults, ...local }); },
          remove(keys, callback) {
            for (const key of keys) delete local[key];
            callback?.();
          },
        },
      },
    };
    const withScope = Function(
      'chrome',
      'window',
      'currentBookmarkTimelineAccountId',
      'BOOKMARK_TIMELINE_CACHE_KEY',
      'BOOKMARK_TIMELINE_SETTINGS_KEY',
      'BOOKMARK_TIMELINE_AUTO_ATTEMPT_KEY',
      'BOOKMARK_TIMELINE_MANUAL_ATTEMPT_KEY',
      'globalThis',
      `${bridge.slice(start, end)}; return withBookmarkTimelineScope;`,
    )(
      chrome,
      { postMessage() {} },
      () => '123',
      'bookmarkTimelineCache',
      'bookmarkTimelineSettings',
      'bookmarkTimelineAutoAttemptAt',
      'bookmarkTimelineManualAttemptAt',
      { __xvmBookmarkTimelineStorage: loadStorageApi() },
    );

    // When
    withScope(() => {});

    // Then
    expect(local.bookmarkTimelineSettings).toEqual({
      accountId: '123', enabled: false, folderIds: ['1000'], every: 20,
    });
    expect(local.bookmarkTimelineCache).toBeUndefined();
  });

  it('builds BookmarkFolderTimeline requests like Xillot', () => {
    expect(bridge).toContain("OP_BOOKMARK_FOLDER_TIMELINE = { name: 'BookmarkFolderTimeline'");
    expect(bridge).toContain('oKopHt25pa6yhDn1ek7Qng');
    expect(bridge).toContain('bookmark_collection_id: folderId');
    expect(bridge).toContain('includePromotedContent: false');
    expect(bridge).toContain('discoverBookmarkFolderTimelineQueryId');
    expect(bridge).toContain('X_MAIN_BUNDLE_RE');
    expect(bridge).toContain('client-web\\/main\\.');
    expect(bridge).toContain('featureSwitches');
    expect(bridge).toContain('buildBookmarkTimelineFeatures');
    expect(bridge).toContain('BookmarkFolderTimeline 404');
    expect(bridge).toContain('retryWithFreshQueryId');
    expect(bridge).toContain('requestBookmarkTimelineTxId');
    expect(content).toContain('captureBookmarkTimelineQueryId');
    expect(content).toContain('XVM_BOOKMARK_TIMELINE_QID_CAPTURED');
    expect(bridge).toContain('BOOKMARK_TIMELINE_QID_CACHE_KEY');
    expect(bridge).toContain('applyBookmarkTimelineQueryId');
    expect(bridge).toContain("'x-client-transaction-id'");
    expect(content).toContain('XVM_BOOKMARK_TIMELINE_TXID_REQUEST');
    expect(content).toContain('window.__xvmXct?.generateTxId');
  });

  it('adds an in-page cog entry and modal for bookmark timeline settings', () => {
    expect(content).toContain('ensureBookmarkTimelineCog');
    expect(content).toContain('showBookmarkTimelineSettings');
    expect(content).toContain("const firstTab = tl?.querySelector?.('[role=\"tab\"]')");
    expect(content).toContain("const firstTabItem = firstTab.closest('[role=\"presentation\"]') || firstTab");
    expect(content).toContain('firstTabItem.after(btn)');
    expect(content).toContain('_bookmarkTimelineCogTimer = setInterval');
    expect(content).toContain('window.__xvmBtiState');
    expect(content).toContain("console.debug('[XVM-BTI]'");
    expect(content).toContain("localStorage.getItem('xvmBtiDebug') === '1'");
    expect(content).toContain('XVM_BOOKMARK_TIMELINE_REFRESH');
    expect(content).toContain('XVM_BOOKMARK_TIMELINE_CACHE_UPDATE');
    expect(content).toContain('XVM_BOOKMARK_TIMELINE_INJECT_SAVE');
    expect(content).toContain('bookmarkTimelineInsertedTweetIds');
    expect(content).toContain('renderBookmarkTimelineBadges');
    expect(styles).toContain('.xvm-bookmark-timeline-badge');
    expect(styles).toContain('.xvm-bti-cog');
    expect(styles).toContain('.xvm-bti-backdrop');
  });

  it('inserts cached bookmark entries after the configured number of timeline tweets', () => {
    const { cacheBookmarkTimelineEntries, injectBookmarkTimelineEntries } = loadApi();
    const cache = new Map();
    cacheBookmarkTimelineEntries(cache, 'folder-a', {
      data: {
        bookmark_timeline: {
          timeline: {
            instructions: [{ type: 'TimelineAddEntries', entries: [tweetEntry('90'), tweetEntry('91')] }],
          },
        },
      },
    });

    const patched = injectBookmarkTimelineEntries(homeTimeline(['1', '2', '3', '4', '5']), cache, {
      enabled: true,
      folderIds: ['folder-a'],
      every: 5,
    });

    const entries = patched.data.home.home_timeline_urt.instructions[0].entries;
    expect(entries.map((entry) => entry.content.itemContent.tweet_results.result.rest_id))
      .toEqual(['1', '2', '3', '4', '5', '90']);
    expect(entries[5].entryId).toMatch(/^xvm-bookmark-folder-a-90-/);
    expect(entries[5].content.entryType).toBe('TimelineTimelineItem');
    expect(entries[5].content.itemContent.itemType).toBe('TimelineTweet');
    expect(BigInt(entries[4].sortIndex)).toBeGreaterThan(BigInt(entries[5].sortIndex));
  });

  it('clamps bookmark insertion intervals below five', () => {
    const { injectBookmarkTimelineEntries } = loadApi();
    const cache = new Map([['folder-a', [tweetEntry('90')]]]);

    const patched = injectBookmarkTimelineEntries(homeTimeline(['1', '2', '3', '4']), cache, {
      enabled: true,
      folderIds: ['folder-a'],
      every: 1,
    });

    const ids = patched.data.home.home_timeline_urt.instructions[0].entries
      .map((entry) => entry.content.itemContent.tweet_results.result.rest_id);
    expect(ids).toEqual(['1', '2', '3', '4']);
  });

  it('caches tweets across every paginated page in a { pages: [...] } payload', () => {
    const { cacheBookmarkTimelineEntries } = loadApi();
    const cache = new Map();
    const page = (...ids) => ({
      data: {
        bookmark_collection_timeline: {
          timeline: {
            instructions: [{ type: 'TimelineAddEntries', entries: ids.map(tweetEntry) }],
          },
        },
      },
    });
    // bridge.js posts { pages: [page1, page2, ...] }; the parser must dedupe
    // across all of them (page 2 repeats '92') and gather the full set.
    const count = cacheBookmarkTimelineEntries(cache, 'folder-a', {
      pages: [page('90', '91', '92'), page('92', '93', '94')],
    });
    expect(count).toBe(5);
    expect(cache.get('folder-a').map((e) => e.content.itemContent.tweet_results.result.rest_id))
      .toEqual(['90', '91', '92', '93', '94']);
  });

  it('backs off repeated background refresh attempts across page loads', async () => {
    // Given
    const start = bridge.indexOf('function autoRefreshBookmarkTimeline(');
    const end = bridge.indexOf('\nfunction ensureBookmarkTimelineAutoTimer(', start);
    const storage = {
      bookmarkTimelineCache: { accountId: '123', folders: {} },
      bookmarkTimelineAutoAttemptAt: { accountId: '123', folders: {} },
    };
    const refreshes = [];
    const chrome = {
      storage: {
        local: {
          get(defaults, callback) { callback({ ...defaults, ...storage }); },
          set(values, callback) { Object.assign(storage, values); callback?.(); },
        },
      },
    };
    const autoRefresh = Function(
      'chrome',
      'navigator',
      'safeChromeCall',
      'withBookmarkTimelineScope',
      'pruneBookmarkTimelineCache',
      'refreshBookmarkTimelineFolders',
      'globalThis',
      'console',
      `
        const DEFAULT_FEATURES = {
          featureBookmarkTimelineInject: false,
          bookmarkTimelineInjectFolderIds: [],
        };
        const BOOKMARK_TIMELINE_CACHE_KEY = 'bookmarkTimelineCache';
        const BOOKMARK_TIMELINE_AUTO_ATTEMPT_KEY = 'bookmarkTimelineAutoAttemptAt';
        const BOOKMARK_TIMELINE_AUTO_TTL_MS = 30 * 60 * 1000;
        const BOOKMARK_TIMELINE_AUTO_LOCK = 'xvm-bookmark-timeline-auto-refresh';
        ${bridge.slice(start, end)}
        return autoRefreshBookmarkTimeline;
      `,
    )(
      chrome,
      { locks: { request: (_name, _options, callback) => callback({}) } },
      (callback) => callback(),
      (callback) => callback({ accountId: '123', folderIds: ['1000'] }),
      (_scope, callback) => { callback(); return Promise.resolve(); },
      async (ids, background) => { refreshes.push({ ids, background }); },
      { __xvmBookmarkTimelineStorage: loadStorageApi() },
      { debug() {}, warn() {} },
    );

    // When
    await autoRefresh(false);
    await autoRefresh(false);

    // Then
    expect(refreshes).toEqual([{ ids: ['1000'], background: true }]);
    expect(storage.bookmarkTimelineAutoAttemptAt.folders['1000']).toBeGreaterThan(0);
  });

  it('keeps background failures out of extension warnings', async () => {
    // Given
    const start = bridge.indexOf('async function refreshBookmarkTimelineFolders(');
    const end = bridge.indexOf('\nfunction hydrateBookmarkTimelineCacheToPage(', start);
    const warnings = [];
    const debug = [];
    const refreshFolders = Function(
      'refreshBookmarkTimelineFolder',
      'console',
      'window',
      'globalThis',
      `${bridge.slice(start, end)}; return refreshBookmarkTimelineFolders;`,
    )(
      async () => { throw new TypeError('Failed to fetch'); },
      {
        warn: (...args) => warnings.push(args),
        debug: (...args) => debug.push(args),
      },
      { postMessage() {} },
      { __xvmBookmarkTimelineStorage: loadStorageApi() },
    );

    // When
    await refreshFolders(['1000'], true);

    // Then
    expect(warnings).toEqual([]);
    expect(debug).toHaveLength(1);
    expect(content).toContain('if (!event.data.background) showToast(');
  });

  it('skips bookmark entries already present in the timeline response', () => {
    const { injectBookmarkTimelineEntries } = loadApi();
    const cache = new Map();
    cache.set('folder-a', [tweetEntry('2'), tweetEntry('90')]);

    const patched = injectBookmarkTimelineEntries(homeTimeline(['1', '2', '3', '4', '5']), cache, {
      enabled: true,
      folderIds: ['folder-a'],
      every: 5,
    });

    const ids = patched.data.home.home_timeline_urt.instructions[0].entries
      .map((entry) => entry.content.itemContent.tweet_results.result.rest_id);
    expect(ids).toEqual(['1', '2', '3', '4', '5', '90']);
  });

  it('skips bookmark entries already inserted earlier', () => {
    const { injectBookmarkTimelineEntries } = loadApi();
    const cache = new Map([['folder-a', [tweetEntry('90'), tweetEntry('91')]]]);

    const patched = injectBookmarkTimelineEntries(homeTimeline(['1', '2', '3', '4', '5']), cache, {
      enabled: true,
      folderIds: ['folder-a'],
      every: 5,
      excludedTweetIds: ['90'],
    });

    const ids = patched.data.home.home_timeline_urt.instructions[0].entries
      .map((entry) => entry.content.itemContent.tweet_results.result.rest_id);
    expect(ids).toEqual(['1', '2', '3', '4', '5', '91']);
  });

  it('targets the home timeline entries instead of earlier unrelated entry arrays', () => {
    const { injectBookmarkTimelineEntries } = loadApi();
    const cache = new Map([['folder-a', [tweetEntry('90')]]]);
    const timeline = {
      unrelated: { entries: [tweetEntry('999')] },
      ...homeTimeline(['1', '2', '3', '4', '5']),
    };

    const patched = injectBookmarkTimelineEntries(timeline, cache, {
      enabled: true,
      folderIds: ['folder-a'],
      every: 5,
    });

    expect(patched.unrelated.entries.map((entry) => entry.content.itemContent.tweet_results.result.rest_id))
      .toEqual(['999']);
    expect(patched.data.home.home_timeline_urt.instructions[0].entries
      .map((entry) => entry.content.itemContent.tweet_results.result.rest_id))
      .toEqual(['1', '2', '3', '4', '5', '90']);
  });

  it('does not inject anything until at least one folder is selected', () => {
    const { injectBookmarkTimelineEntries } = loadApi();
    const cache = new Map([['folder-a', [tweetEntry('90')]]]);
    const timeline = homeTimeline(['1', '2']);

    const patched = injectBookmarkTimelineEntries(timeline, cache, {
      enabled: true,
      folderIds: [],
      every: 1,
    });

    const ids = patched.data.home.home_timeline_urt.instructions[0].entries
      .map((entry) => entry.content.itemContent.tweet_results.result.rest_id);
    expect(ids).toEqual(['1', '2']);
  });
});
