// X-Tools 数据中心共享解析器：供 X 页面采集器与扩展后台同步器复用。
// 解析策略参考 Scrollmark（MIT），并兼容 X 当前多层 Timeline 包装结构。
((root) => {
  'use strict';

  function unwrapTweet(value) {
    let node = value;
    for (let index = 0; index < 8; index += 1) {
      if (!node || typeof node !== 'object') return null;
      if (node.__typename === 'TweetWithVisibilityResults' && node.tweet) { node = node.tweet; continue; }
      if (node.tweet_results?.result) { node = node.tweet_results.result; continue; }
      if (node.result?.rest_id && (node.result.legacy || node.result.core || node.result.__typename === 'Tweet')) { node = node.result; continue; }
      if (node.tweet?.rest_id && (node.tweet.legacy || node.tweet.core)) { node = node.tweet; continue; }
      break;
    }
    if (node?.__typename === 'TweetTombstone' || node?.__typename === 'TweetUnavailable') return null;
    return node?.rest_id && (node.legacy || node.core || node.__typename === 'Tweet') ? node : null;
  }

  function findTweets(rootValue) {
    const found = new Map();
    const seen = new WeakSet();
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 28 || seen.has(node)) return;
      seen.add(node);
      const tweet = unwrapTweet(node);
      if (tweet?.rest_id) {
        found.set(String(tweet.rest_id), tweet);
        return;
      }
      if (Array.isArray(node)) node.forEach((child) => walk(child, depth + 1));
      else Object.values(node).forEach((child) => walk(child, depth + 1));
    };
    walk(rootValue, 0);
    return [...found.values()];
  }

  function cursorFrom(rootValue) {
    let cursor = '';
    const seen = new WeakSet();
    const walk = (node, depth) => {
      if (cursor || !node || typeof node !== 'object' || depth > 24 || seen.has(node)) return;
      seen.add(node);
      const entryId = String(node.entryId || node.entry_id || '');
      const type = String(node.cursorType || node.cursor_type || node.content?.cursorType || '');
      const value = node.value || node.content?.value || node.cursor || '';
      if ((type.toLowerCase() === 'bottom' || entryId.includes('cursor-bottom')) && value) cursor = String(value);
      if (!cursor) Object.values(node).forEach((child) => walk(child, depth + 1));
    };
    walk(rootValue, 0);
    return cursor;
  }

  function uniqueMedia(items) {
    const output = new Map();
    items.filter((item) => item?.url).forEach((item) => output.set(item.url, item));
    return [...output.values()].slice(0, 12);
  }

  function mediaFrom(tweet, legacy) {
    const media = legacy?.extended_entities?.media || legacy?.entities?.media || [];
    const result = media.map((item) => {
      const video = (item?.video_info?.variants || []).filter((value) => value?.url && (!value.content_type || value.content_type.includes('mp4'))).sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))[0];
      return {
        type: item?.type || (video ? 'video' : 'image'),
        url: video?.url || item?.media_url_https || item?.media_url || '',
        previewUrl: item?.media_url_https || item?.media_url || '',
        width: Number(item?.original_info?.width || 0),
        height: Number(item?.original_info?.height || 0),
        altText: String(item?.ext_alt_text || ''),
      };
    });
    const article = tweet?.article?.article_results?.result || tweet?.article_results?.result || {};
    const cover = article?.cover_media?.media_info || article?.cover_media || {};
    const coverUrl = cover?.original_img_url || cover?.media_url_https || cover?.media_url || '';
    if (coverUrl) result.push({ type: 'image', url: coverUrl, previewUrl: coverUrl });
    return uniqueMedia(result);
  }

  function noteResult(tweet) {
    return tweet?.note_tweet?.note_tweet_results?.result || tweet?.note_tweet_results?.result || {};
  }

  function articleResult(tweet) {
    return tweet?.article?.article_results?.result || tweet?.article_results?.result || {};
  }

  function cardTitle(tweet) {
    const values = tweet?.card?.legacy?.binding_values || tweet?.card?.binding_values || [];
    const list = Array.isArray(values) ? values : Object.entries(values).map(([key, value]) => ({ key, value }));
    const item = list.find((entry) => ['title', 'twitter:title'].includes(String(entry?.key || '').toLowerCase()));
    return String(item?.value?.string_value || item?.value?.stringValue || item?.value || '');
  }

  function titleFrom(tweet) {
    const article = articleResult(tweet);
    return String(article?.title || article?.name || cardTitle(tweet) || '').trim();
  }

  function textFrom(tweet, legacy) {
    const note = noteResult(tweet);
    const article = articleResult(tweet);
    const articleText = article?.preview_text || article?.description || '';
    return String(note?.text || legacy?.full_text || legacy?.text || articleText || '').trim();
  }

  function kindForOperation(operation) {
    if (operation === 'Bookmarks' || operation === 'BookmarkFolderTimeline') return 'bookmark';
    if (operation === 'Likes') return 'like';
    return 'authored_post';
  }

  function normalizeTweet(tweet, kind, viewerId) {
    const legacy = tweet?.legacy || {};
    const text = textFrom(tweet, legacy);
    if (legacy.retweeted_status_result || /^RT\s+@/i.test(text)) return null;
    const user = tweet?.core?.user_results?.result || tweet?.user_results?.result || {};
    const userLegacy = user?.legacy || {};
    const userCore = user?.core || {};
    const authorId = String(user?.rest_id || legacy.user_id_str || '');
    if ((kind === 'authored_post' || kind === 'authored_reply') && viewerId && authorId && authorId !== String(viewerId)) return null;
    const resolvedKind = kind.startsWith('authored_') ? (legacy.in_reply_to_status_id_str ? 'authored_reply' : 'authored_post') : kind;
    const title = titleFrom(tweet);
    return {
      accountId: viewerId || 'current',
      kind: resolvedKind,
      capturedAt: Date.now(),
      post: {
        id: String(tweet.rest_id),
        title,
        text: text || title,
        lang: String(legacy.lang || ''),
        authorId,
        authorName: userCore.name || userLegacy.name || 'X 用户',
        authorHandle: userCore.screen_name || userLegacy.screen_name || '',
        authorAvatar: user?.avatar?.image_url || userLegacy.profile_image_url_https || '',
        createdAt: Date.parse(legacy.created_at || '') || Date.now(),
        conversationId: legacy.conversation_id_str || '',
        inReplyToId: legacy.in_reply_to_status_id_str || '',
        quotedPostId: legacy.quoted_status_id_str || '',
        media: mediaFrom(tweet, legacy),
        metrics: {
          views: Number(tweet?.views?.count || tweet?.view_count_info?.count || legacy.view_count || 0),
          likes: Number(legacy.favorite_count || 0),
          reposts: Number(legacy.retweet_count || 0),
          replies: Number(legacy.reply_count || 0),
          bookmarks: Number(legacy.bookmark_count || 0),
        },
        updatedAt: Date.now(),
      },
    };
  }

  function extractUsers(rootValue) {
    const output = new Map();
    const seen = new WeakSet();
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 24 || seen.has(node)) return;
      seen.add(node);
      const legacy = node.legacy && typeof node.legacy === 'object' ? node.legacy : {};
      const core = node.core && typeof node.core === 'object' ? node.core : {};
      const handle = String(core.screen_name || legacy.screen_name || '').toLowerCase();
      if (/^[a-z0-9_]{1,15}$/i.test(handle)) {
        const existing = output.get(handle) || {};
        const perspective = node.relationship_perspectives || node.relationshipPerspectives || {};
        const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
        output.set(handle, {
          ...existing,
          handle,
          id: String(node.rest_id || legacy.id_str || existing.id || ''),
          n: core.name || legacy.name || existing.n || '',
          a: node.avatar?.image_url || legacy.profile_image_url_https || existing.a || '',
          bio: legacy.description || existing.bio || '',
          location: legacy.location || existing.location || '',
          url: legacy.entities?.url?.urls?.[0]?.expanded_url || legacy.url || existing.url || '',
          joinedAt: numberOr(Date.parse(core.created_at || legacy.created_at || ''), existing.joinedAt),
          verified: typeof legacy.verified === 'boolean' ? legacy.verified : existing.verified,
          blueVerified: typeof node.is_blue_verified === 'boolean' ? node.is_blue_verified : existing.blueVerified,
          verifiedType: node.verification?.verified_type || existing.verifiedType || '',
          protected: typeof legacy.protected === 'boolean' ? legacy.protected : existing.protected,
          fc: numberOr(legacy.followers_count, existing.fc),
          fd: numberOr(legacy.friends_count, existing.fd),
          statusesCount: numberOr(legacy.statuses_count, existing.statusesCount),
          mediaCount: numberOr(legacy.media_count, existing.mediaCount),
          favouritesCount: numberOr(legacy.favourites_count, existing.favouritesCount),
          listedCount: numberOr(legacy.listed_count, existing.listedCount),
          f: typeof perspective.following === 'boolean' ? Number(perspective.following) : (typeof legacy.following === 'boolean' ? Number(legacy.following) : existing.f),
          b: typeof perspective.followed_by === 'boolean' ? Number(perspective.followed_by) : (typeof legacy.followed_by === 'boolean' ? Number(legacy.followed_by) : existing.b),
        });
      }
      if (Array.isArray(node)) node.forEach((child) => walk(child, depth + 1));
      else Object.values(node).forEach((child) => walk(child, depth + 1));
    };
    walk(rootValue, 0);
    return [...output.values()];
  }

  root.XvmLibraryNormalize = {
    unwrapTweet, findTweets, cursorFrom, kindForOperation, normalizeTweet, extractUsers,
    mediaFrom, textFrom, titleFrom,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
