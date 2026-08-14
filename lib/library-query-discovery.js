// X GraphQL Query ID 动态发现。
// 基于 xarchive（MIT）的 bundle 扫描策略重新实现，扩展到数据中心全部读取操作。
((root) => {
  'use strict';

  const OPERATIONS = [
    'Bookmarks', 'BookmarkFoldersSlice', 'BookmarkFolderTimeline', 'Likes',
    'UserTweets', 'UserTweetsAndReplies', 'Following', 'Followers',
  ];
  const WANTED = new Set(OPERATIONS);
  const PATTERNS = [
    /queryId:\s*["']([A-Za-z0-9_-]+)["'][^}]{0,700}operationName:\s*["']([^"']+)["']/g,
    /operationName:\s*["']([^"']+)["'][^}]{0,700}queryId:\s*["']([A-Za-z0-9_-]+)["']/g,
    /["']queryId["']\s*:\s*["']([A-Za-z0-9_-]+)["'][^}]{0,700}["']operationName["']\s*:\s*["']([^"']+)["']/g,
    /["']operationName["']\s*:\s*["']([^"']+)["'][^}]{0,700}["']queryId["']\s*:\s*["']([A-Za-z0-9_-]+)["']/g,
  ];

  function extractQueryIds(source, target = {}) {
    const text = String(source || '');
    for (let index = 0; index < PATTERNS.length; index += 1) {
      const pattern = PATTERNS[index];
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text))) {
        const firstIsOperation = WANTED.has(match[1]);
        const operation = firstIsOperation ? match[1] : match[2];
        const queryId = firstIsOperation ? match[2] : match[1];
        if (WANTED.has(operation) && /^[A-Za-z0-9_-]{8,}$/.test(queryId)) target[operation] = queryId;
      }
    }
    for (const operation of OPERATIONS.filter((name) => !target[name])) {
      const marker = text.indexOf(`"${operation}"`);
      if (marker < 0) continue;
      const region = text.slice(Math.max(0, marker - 350), Math.min(text.length, marker + operation.length + 350));
      const candidates = [...region.matchAll(/["']([A-Za-z0-9_-]{15,})["']/g)].map((item) => item[1]).filter((item) => item !== operation && !/^[a-z_]+$/.test(item));
      if (candidates[0]) target[operation] = candidates[0];
    }
    return target;
  }

  function scriptUrls(html) {
    const urls = String(html || '').match(/https:\/\/[^"'\s<>]+\.js(?:\?[^"'\s<>]*)?/g) || [];
    return [...new Set(urls)].sort((a, b) => Number(/client-web|responsive-web/.test(b)) - Number(/client-web|responsive-web/.test(a)));
  }

  async function discover({ fetchFn = root.fetch?.bind(root), maxBundles = 24, pages = ['https://x.com', 'https://x.com/i/bookmarks'] } = {}) {
    if (typeof fetchFn !== 'function') throw new Error('fetch_unavailable');
    const result = {};
    const bundles = [];
    for (const page of pages) {
      try {
        const response = await fetchFn(page, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) continue;
        bundles.push(...scriptUrls(await response.text()));
      } catch (_) {}
    }
    for (const url of [...new Set(bundles)].slice(0, maxBundles)) {
      try {
        const response = await fetchFn(url, { cache: 'force-cache' });
        if (!response.ok) continue;
        extractQueryIds(await response.text(), result);
        if (OPERATIONS.every((operation) => result[operation])) break;
      } catch (_) {}
    }
    return result;
  }

  root.XvmLibraryQueryDiscovery = { OPERATIONS, extractQueryIds, scriptUrls, discover };
})(typeof globalThis !== 'undefined' ? globalThis : self);
