(() => {
  const RETENTION_MS = 24 * 60 * 60 * 1000;
  const MAX_ENTRY_BYTES = 128 * 1024;
  const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
  const MAX_ENTRIES_PER_FOLDER = 120;
  const MAX_FOLDERS = 20;

  function accountIdFromCookie(cookie = '') {
    const match = String(cookie).match(/(?:^|;\s*)twid=([^;]+)/);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]).match(/^u=(\d+)$/)?.[1] || '';
    } catch (_) {
      return '';
    }
  }

  function getTweetId(entry) {
    const result = entry?.content?.itemContent?.tweet_results?.result;
    return result?.rest_id || result?.tweet?.rest_id || null;
  }

  function sanitizeFolderIds(folderIds) {
    return [...new Set((Array.isArray(folderIds) ? folderIds : [])
      .map((value) => String(value || '').trim())
      .filter((value) => /^\d{1,32}$/.test(value)))]
      .slice(0, MAX_FOLDERS);
  }

  function isTweetEntry(entry) {
    return !!getTweetId(entry)
      && entry?.content?.entryType === 'TimelineTimelineItem'
      && entry?.content?.itemContent?.itemType === 'TimelineTweet';
  }

  function findEntryArrays(value, out = []) {
    if (!value || typeof value !== 'object') return out;
    if (Array.isArray(value)) {
      for (const item of value) findEntryArrays(item, out);
      return out;
    }
    if (Array.isArray(value.entries) && value.entries.some(isTweetEntry)) out.push(value.entries);
    for (const child of Object.values(value)) findEntryArrays(child, out);
    return out;
  }

  function safeCloneEntry(entry) {
    if (!isTweetEntry(entry)) return null;
    let json;
    try { json = JSON.stringify(entry); }
    catch (_) { return null; }
    if (!json || new TextEncoder().encode(json).byteLength > MAX_ENTRY_BYTES) return null;
    try { return JSON.parse(json); }
    catch (_) { return null; }
  }

  function sanitizeEntries(entries, maxBytes = MAX_TOTAL_BYTES) {
    const output = [];
    const seen = new Set();
    let bytes = 0;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const clone = safeCloneEntry(entry);
      const id = getTweetId(clone);
      if (!clone || !id || seen.has(id)) continue;
      const size = new TextEncoder().encode(JSON.stringify(clone)).byteLength;
      if (bytes + size > maxBytes) break;
      seen.add(id);
      bytes += size;
      output.push(clone);
      if (output.length >= MAX_ENTRIES_PER_FOLDER) break;
    }
    return output;
  }

  function extractEntries(json) {
    return sanitizeEntries(findEntryArrays(json).flat());
  }

  function resolveScope(accountId, ownerAccountId, enabled, folderIds) {
    const id = String(accountId || '');
    const selected = sanitizeFolderIds(folderIds);
    if (!id) return { action: 'idle', scope: null };
    if (!enabled || !selected.length) return { action: 'clear', scope: null };
    if (String(ownerAccountId || '') !== id) return { action: 'reset', scope: null };
    return { action: 'use', scope: { accountId: id, folderIds: selected } };
  }

  function normalizeCacheDocument(raw, accountId, selectedFolderIds, now = Date.now()) {
    const id = String(accountId || '');
    const selected = new Set(sanitizeFolderIds(selectedFolderIds));
    const output = { accountId: id, folders: {} };
    if (!id || raw?.accountId !== id || !raw?.folders || typeof raw.folders !== 'object') return output;
    let remainingBytes = MAX_TOTAL_BYTES;
    for (const [folderId, record] of Object.entries(raw.folders)) {
      const refreshedAt = Number(record?.refreshedAt) || 0;
      if (!selected.has(folderId) || now - refreshedAt > RETENTION_MS) continue;
      if (!Array.isArray(record?.entries)) continue;
      const entries = sanitizeEntries(record.entries, remainingBytes);
      if (entries.length || record.entries.length === 0) {
        output.folders[folderId] = { entries, refreshedAt };
        remainingBytes -= new TextEncoder().encode(JSON.stringify(entries)).byteLength;
      }
      if (remainingBytes <= 0) break;
    }
    return output;
  }

  globalThis.__xvmBookmarkTimelineStorage = {
    RETENTION_MS,
    accountIdFromCookie,
    extractEntries,
    getTweetId,
    normalizeCacheDocument,
    resolveScope,
    sanitizeFolderIds,
    sanitizeEntries,
  };
})();
