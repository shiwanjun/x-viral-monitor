export type LibraryKind = 'bookmark' | 'like' | 'authored_post' | 'authored_reply';

export interface NormalizedPost {
  id: string; text: string; authorId: string; authorName: string; authorHandle: string;
  authorAvatar: string; createdAt: number; conversationId: string; inReplyToId: string;
  quotedPostId: string; media: Array<{ type: string; url: string; previewUrl: string }>;
  metrics: { views: number; likes: number; reposts: number; replies: number; bookmarks: number };
  contentHash: string; updatedAt: number;
}

export interface CollectionItem {
  id: string; accountId: string; postId: string; kind: LibraryKind;
  sourceFolderId: string; sourceFolderName: string; sourceRemovedAt: number | null;
  archivedAt: number | null; archiveExpiresAt: number | null; capturedAt: number; updatedAt: number;
}

export interface LibraryQuery {
  kind?: LibraryKind | 'all'; search?: string; tagId?: string; folderId?: string;
  media?: 'media' | 'text' | ''; from?: number; to?: number; includeArchived?: boolean;
  cursor?: string | null; limit?: number;
}

export interface LibraryFacet { id: string; name: string; color: string; updatedAt: number }
export interface SyncChange { id: string; entityType: string; entityId: string; op: 'upsert' | 'delete'; value: unknown; updatedAt: number; deviceId: string }
export interface SyncManifest { cursor: number; changeCount: number; bytesUsed: number; updatedAt: number }
export interface QuotaState { tier: 'free' | 'pro'; limit: 1000 | 100000; used: number; locked: number }
export interface BatchActionResult { postId: string; ok: boolean; status?: number; error?: string }
export type LibraryError = 'unauthorized' | 'membership_required' | 'account_mismatch' | 'quota_exceeded' | 'cursor_conflict' | 'rate_limited';
