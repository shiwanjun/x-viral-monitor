// X-Tools local library database. Runs in the extension service worker and
// deliberately never touches x.com storage. Exposed as globalThis.XvmLibraryDb
// so the MV3 classic worker can load it through importScripts().
(function (root) {
  'use strict';

  const DB_NAME = 'x-tools-library';
  const DB_VERSION = 1;
  const FREE_QUOTA = 1_000;
  const PRO_QUOTA = 100_000;
  const ARCHIVE_UNDO_MS = 30 * 24 * 60 * 60 * 1000;
  const KINDS = new Set(['bookmark', 'like', 'authored_post', 'authored_reply']);
  let dbPromise;

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexeddb_request_failed'));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('indexeddb_transaction_failed'));
      transaction.onabort = () => reject(transaction.error || new Error('indexeddb_transaction_aborted'));
    });
  }

  function createStore(db, name, keyPath, indexes = []) {
    if (db.objectStoreNames.contains(name)) return;
    const store = db.createObjectStore(name, { keyPath });
    indexes.forEach(([indexName, path, options]) => store.createIndex(indexName, path, options || {}));
  }

  function open() {
    if (dbPromise) return dbPromise;
    if (!root.indexedDB) return Promise.reject(new Error('indexeddb_unavailable'));
    dbPromise = new Promise((resolve, reject) => {
      const request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        createStore(db, 'accounts', 'id', [['byLastSeen', 'lastSeenAt']]);
        createStore(db, 'posts', 'id', [['byUpdatedAt', 'updatedAt'], ['byAuthor', 'authorHandle']]);
        createStore(db, 'collectionItems', 'id', [
          ['byKindUpdated', ['kind', 'updatedAt']],
          ['byPost', 'postId'],
          ['byAccount', 'accountId'],
          ['byArchived', 'archivedAt'],
        ]);
        createStore(db, 'tags', 'id', [['byName', 'name', { unique: false }]]);
        createStore(db, 'tagAssignments', 'id', [['byItem', 'itemId'], ['byTag', 'tagId']]);
        createStore(db, 'folders', 'id', [['byName', 'name', { unique: false }]]);
        createStore(db, 'folderAssignments', 'id', [['byItem', 'itemId'], ['byFolder', 'folderId']]);
        createStore(db, 'syncState', 'id');
        createStore(db, 'outbox', 'id', [['byUpdatedAt', 'updatedAt']]);
        createStore(db, 'tombstones', 'id', [['byExpiresAt', 'expiresAt']]);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => { dbPromise = null; reject(request.error || new Error('indexeddb_open_failed')); };
    });
    return dbPromise;
  }

  function cleanText(value, max = 100_000) {
    return String(value == null ? '' : value).slice(0, max);
  }

  function cleanNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  async function digest(value) {
    const text = cleanText(value, 250_000);
    if (!root.crypto?.subtle) return `${text.length}:${text.slice(0, 48)}`;
    const bytes = new TextEncoder().encode(text);
    const buffer = await root.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function normalizePost(raw, now = Date.now()) {
    const id = cleanText(raw?.id || raw?.postId, 64);
    if (!id) throw new Error('invalid_post');
    const media = (Array.isArray(raw?.media) ? raw.media : []).slice(0, 8).map((item) => ({
      type: cleanText(item?.type || 'image', 20),
      url: cleanText(item?.url || item?.mediaUrl, 2_000),
      previewUrl: cleanText(item?.previewUrl || item?.url || item?.mediaUrl, 2_000),
    })).filter((item) => item.url);
    return {
      id,
      text: cleanText(raw?.text, 100_000),
      authorId: cleanText(raw?.authorId, 64),
      authorName: cleanText(raw?.authorName || raw?.name || 'X 用户', 160),
      authorHandle: cleanText(raw?.authorHandle || raw?.handle, 64).replace(/^@/, ''),
      authorAvatar: cleanText(raw?.authorAvatar || raw?.avatar, 2_000),
      createdAt: cleanNumber(raw?.createdAt) || now,
      conversationId: cleanText(raw?.conversationId, 64),
      inReplyToId: cleanText(raw?.inReplyToId, 64),
      quotedPostId: cleanText(raw?.quotedPostId, 64),
      media,
      metrics: {
        views: cleanNumber(raw?.metrics?.views ?? raw?.views),
        likes: cleanNumber(raw?.metrics?.likes ?? raw?.likes),
        reposts: cleanNumber(raw?.metrics?.reposts ?? raw?.reposts),
        replies: cleanNumber(raw?.metrics?.replies ?? raw?.replies),
        bookmarks: cleanNumber(raw?.metrics?.bookmarks ?? raw?.bookmarks),
      },
      updatedAt: cleanNumber(raw?.updatedAt) || now,
    };
  }

  function normalizeCollection(raw, post, now = Date.now()) {
    const kind = cleanText(raw?.kind, 32);
    if (!KINDS.has(kind)) throw new Error('invalid_library_kind');
    const accountId = cleanText(raw?.accountId || 'current', 64);
    return {
      id: `${accountId}:${kind}:${post.id}`,
      accountId,
      postId: post.id,
      kind,
      sourceFolderId: cleanText(raw?.sourceFolderId, 128),
      sourceFolderName: cleanText(raw?.sourceFolderName, 160),
      sourceRemovedAt: cleanNumber(raw?.sourceRemovedAt) || null,
      archivedAt: cleanNumber(raw?.archivedAt) || null,
      archiveExpiresAt: cleanNumber(raw?.archiveExpiresAt) || null,
      capturedAt: cleanNumber(raw?.capturedAt) || now,
      updatedAt: cleanNumber(raw?.updatedAt) || now,
    };
  }

  async function putCapture(raw, options = {}) {
    const db = await open();
    const now = Date.now();
    const post = normalizePost(raw?.post || raw, now);
    post.contentHash = await digest(JSON.stringify({ text: post.text, media: post.media, metrics: post.metrics }));
    const item = normalizeCollection(raw, post, now);
    const tx = db.transaction(['posts', 'collectionItems', 'accounts', 'outbox'], 'readwrite');
    tx.objectStore('posts').put(post);
    tx.objectStore('collectionItems').put(item);
    tx.objectStore('accounts').put({
      id: item.accountId,
      handle: cleanText(raw?.accountHandle, 64).replace(/^@/, ''),
      avatar: cleanText(raw?.accountAvatar, 2_000),
      lastSeenAt: now,
    });
    if (!options.skipOutbox) {
      tx.objectStore('outbox').put({
        id: `collection:${item.id}`,
        entityType: 'collection',
        entityId: item.id,
        op: 'upsert',
        value: { post, item },
        updatedAt: item.updatedAt,
        deviceId: cleanText(raw?.deviceId || 'local', 80),
      });
    }
    await transactionDone(tx);
    return item;
  }

  async function putCaptures(records, options = {}) {
    let accepted = 0;
    const errors = [];
    for (const record of (Array.isArray(records) ? records : []).slice(0, 500)) {
      try { await putCapture(record, options); accepted += 1; }
      catch (error) { errors.push(String(error?.message || error)); }
    }
    return { accepted, errors: errors.slice(0, 10) };
  }

  async function listAll(storeName) {
    const db = await open();
    const tx = db.transaction(storeName, 'readonly');
    return requestResult(tx.objectStore(storeName).getAll());
  }

  function matchesQuery(row, query, tagsByItem, foldersByItem) {
    if (query.kind && query.kind !== 'all' && row.item.kind !== query.kind) return false;
    if (!query.includeArchived && row.item.archivedAt) return false;
    if (query.media === 'media' && !row.post.media.length) return false;
    if (query.media === 'text' && row.post.media.length) return false;
    if (query.from && row.post.createdAt < query.from) return false;
    if (query.to && row.post.createdAt > query.to) return false;
    if (query.tagId && !(tagsByItem.get(row.item.id) || []).includes(query.tagId)) return false;
    if (query.folderId && !(foldersByItem.get(row.item.id) || []).includes(query.folderId)) return false;
    const needle = cleanText(query.search, 500).trim().toLocaleLowerCase();
    if (needle && !`${row.post.text} ${row.post.authorName} ${row.post.authorHandle} ${row.item.sourceFolderName}`.toLocaleLowerCase().includes(needle)) return false;
    return true;
  }

  async function query(rawQuery = {}, options = {}) {
    const limit = Math.max(1, Math.min(50, Number(rawQuery.limit) || 50));
    const offset = Math.max(0, Number(rawQuery.cursor) || 0);
    const quota = options.isPro ? PRO_QUOTA : FREE_QUOTA;
    const [items, posts, assignments, folderAssignments, tags, folders] = await Promise.all([
      listAll('collectionItems'), listAll('posts'), listAll('tagAssignments'),
      listAll('folderAssignments'), listAll('tags'), listAll('folders'),
    ]);
    const postMap = new Map(posts.map((post) => [post.id, post]));
    const tagsByItem = new Map();
    assignments.forEach((entry) => tagsByItem.set(entry.itemId, [...(tagsByItem.get(entry.itemId) || []), entry.tagId]));
    const foldersByItem = new Map();
    folderAssignments.forEach((entry) => foldersByItem.set(entry.itemId, [...(foldersByItem.get(entry.itemId) || []), entry.folderId]));
    let rows = items.map((item) => ({ item, post: postMap.get(item.postId) })).filter((row) => row.post);
    rows.sort((a, b) => b.item.updatedAt - a.item.updatedAt || b.post.createdAt - a.post.createdAt);
    const totalStored = rows.length;
    rows = rows.slice(0, quota).filter((row) => matchesQuery(row, rawQuery, tagsByItem, foldersByItem));
    const visibleTotal = rows.length;
    const tagMap = new Map(tags.map((tag) => [tag.id, tag]));
    const folderMap = new Map(folders.map((folder) => [folder.id, folder]));
    return {
      rows: rows.slice(offset, offset + limit).map((row) => ({
        ...row,
        tags: (tagsByItem.get(row.item.id) || []).map((id) => tagMap.get(id)).filter(Boolean),
        folders: (foldersByItem.get(row.item.id) || []).map((id) => folderMap.get(id)).filter(Boolean),
      })),
      cursor: offset + limit < visibleTotal ? String(offset + limit) : null,
      total: visibleTotal,
      quota: { tier: options.isPro ? 'pro' : 'free', limit: quota, used: totalStored, locked: Math.max(0, totalStored - quota) },
    };
  }

  async function facets(options = {}) {
    const result = await query({ limit: 1 }, options);
    const [items, tags, folders] = await Promise.all([listAll('collectionItems'), listAll('tags'), listAll('folders')]);
    const counts = { bookmark: 0, like: 0, authored_post: 0, authored_reply: 0 };
    items.filter((item) => !item.archivedAt).forEach((item) => { if (item.kind in counts) counts[item.kind] += 1; });
    return { counts, tags, folders, quota: result.quota };
  }

  async function upsertNamed(storeName, name, color) {
    const db = await open();
    const now = Date.now();
    const id = `${storeName.slice(0, -1)}:${await digest(`${name}:${now}`)}`;
    const value = { id, name: cleanText(name, 80).trim(), color: cleanText(color || '#7058ed', 20), updatedAt: now };
    if (!value.name) throw new Error('invalid_name');
    const tx = db.transaction([storeName, 'outbox'], 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.objectStore('outbox').put({ id: `${storeName}:${id}`, entityType: storeName, entityId: id, op: 'upsert', value, updatedAt: now, deviceId: 'local' });
    await transactionDone(tx);
    return value;
  }

  async function assign(type, itemIds, targetId) {
    const storeName = type === 'tag' ? 'tagAssignments' : 'folderAssignments';
    const field = type === 'tag' ? 'tagId' : 'folderId';
    const db = await open();
    const tx = db.transaction([storeName, 'outbox'], 'readwrite');
    const now = Date.now();
    for (const itemId of (Array.isArray(itemIds) ? itemIds : []).slice(0, 500)) {
      const id = `${itemId}:${targetId}`;
      const value = { id, itemId: cleanText(itemId, 180), [field]: cleanText(targetId, 180), updatedAt: now };
      tx.objectStore(storeName).put(value);
      tx.objectStore('outbox').put({ id: `${storeName}:${id}`, entityType: storeName, entityId: id, op: 'upsert', value, updatedAt: now, deviceId: 'local' });
    }
    await transactionDone(tx);
    return { ok: true };
  }

  async function archive(itemIds, archived = true) {
    const db = await open();
    const tx = db.transaction(['collectionItems', 'outbox', 'tombstones'], 'readwrite');
    const store = tx.objectStore('collectionItems');
    const now = Date.now();
    for (const id of (Array.isArray(itemIds) ? itemIds : []).slice(0, 500)) {
      const item = await requestResult(store.get(id));
      if (!item) continue;
      item.archivedAt = archived ? now : null;
      item.archiveExpiresAt = archived ? now + ARCHIVE_UNDO_MS : null;
      item.updatedAt = now;
      store.put(item);
      if (archived) tx.objectStore('tombstones').put({ id: `archive:${id}`, entityType: 'collection', entityId: id, deletedAt: now, expiresAt: now + ARCHIVE_UNDO_MS });
      else tx.objectStore('tombstones').delete(`archive:${id}`);
      tx.objectStore('outbox').put({ id: `collection:${id}`, entityType: 'collection', entityId: id, op: 'upsert', value: { item }, updatedAt: now, deviceId: 'local' });
    }
    await transactionDone(tx);
    return { ok: true };
  }

  async function markSourceRemoved(accountId, kind, postId) {
    const db = await open();
    const id = `${cleanText(accountId || 'current', 64)}:${cleanText(kind, 32)}:${cleanText(postId, 64)}`;
    const tx = db.transaction(['collectionItems', 'outbox'], 'readwrite');
    const store = tx.objectStore('collectionItems');
    const item = await requestResult(store.get(id));
    if (!item) return { ok: false, error: 'not_found' };
    item.sourceRemovedAt = Date.now(); item.updatedAt = Date.now();
    store.put(item);
    tx.objectStore('outbox').put({ id: `collection:${id}`, entityType: 'collection', entityId: id, op: 'upsert', value: { item }, updatedAt: item.updatedAt, deviceId: 'local' });
    await transactionDone(tx);
    return { ok: true };
  }

  async function readOutbox(limit = 500) {
    const rows = await listAll('outbox');
    return rows.sort((a, b) => a.updatedAt - b.updatedAt).slice(0, Math.max(1, Math.min(500, limit)));
  }

  async function ackOutbox(ids) {
    const db = await open();
    const tx = db.transaction('outbox', 'readwrite');
    (Array.isArray(ids) ? ids : []).slice(0, 500).forEach((id) => tx.objectStore('outbox').delete(id));
    await transactionDone(tx);
  }

  async function applyChanges(changes) {
    let applied = 0;
    for (const change of (Array.isArray(changes) ? changes : []).slice(0, 500)) {
      const value = change?.value || {};
      if (change?.entityType === 'collection' && value.post && value.item) {
        const db = await open();
        const current = await requestResult(db.transaction('collectionItems', 'readonly').objectStore('collectionItems').get(value.item.id));
        if (current && Number(current.updatedAt || 0) > Number(change.updatedAt || value.item.updatedAt || 0)) continue;
        await putCapture({ ...value.item, post: value.post }, { skipOutbox: true }); applied += 1; continue;
      }
      const storeNames = { tags: 'tags', folders: 'folders', tagAssignments: 'tagAssignments', folderAssignments: 'folderAssignments' };
      const storeName = storeNames[change?.entityType];
      if (!storeName || !value?.id) continue;
      const db = await open();
      const current = await requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).get(value.id));
      if (current && Number(current.updatedAt || 0) > Number(change.updatedAt || value.updatedAt || 0)) continue;
      const tx = db.transaction(storeName, 'readwrite');
      if (change.op === 'delete') tx.objectStore(storeName).delete(value.id); else tx.objectStore(storeName).put(value);
      await transactionDone(tx); applied += 1;
    }
    return { applied };
  }

  async function clearAll() {
    const db = await open();
    const names = Array.from(db.objectStoreNames);
    const tx = db.transaction(names, 'readwrite');
    names.forEach((name) => tx.objectStore(name).clear());
    await transactionDone(tx);
  }

  async function close() {
    if (!dbPromise) return;
    try { (await dbPromise).close(); } finally { dbPromise = null; }
  }

  root.XvmLibraryDb = {
    DB_NAME, DB_VERSION, FREE_QUOTA, PRO_QUOTA, KINDS: [...KINDS],
    open, normalizePost, normalizeCollection, putCapture, putCaptures, query, facets,
    createTag: (name, color) => upsertNamed('tags', name, color),
    createFolder: (name, color) => upsertNamed('folders', name, color),
    assignTag: (itemIds, tagId) => assign('tag', itemIds, tagId),
    assignFolder: (itemIds, folderId) => assign('folder', itemIds, folderId),
    archive, markSourceRemoved, readOutbox, ackOutbox, applyChanges, clearAll, close,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
