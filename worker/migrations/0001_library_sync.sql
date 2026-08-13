-- 数据中心云备份：D1 仅保存账号绑定、清单和 R2 对象索引。
CREATE TABLE IF NOT EXISTS "library_accounts" (
  "user_id" TEXT PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "x_account_id" TEXT NOT NULL,
  "bound_at" INTEGER NOT NULL,
  "retain_until" INTEGER,
  "updated_at" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "library_sync_manifests" (
  "user_id" TEXT PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "x_account_id" TEXT NOT NULL,
  "cursor" INTEGER NOT NULL DEFAULT 0,
  "change_count" INTEGER NOT NULL DEFAULT 0,
  "bytes_used" INTEGER NOT NULL DEFAULT 0,
  "updated_at" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "library_sync_chunks" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "x_account_id" TEXT NOT NULL,
  "object_key" TEXT NOT NULL UNIQUE,
  "cursor" INTEGER NOT NULL,
  "change_count" INTEGER NOT NULL,
  "bytes_used" INTEGER NOT NULL,
  "created_at" INTEGER NOT NULL,
  UNIQUE("user_id", "cursor")
);

CREATE INDEX IF NOT EXISTS "library_sync_chunks_user_cursor_idx"
  ON "library_sync_chunks"("user_id", "cursor");

CREATE INDEX IF NOT EXISTS "library_accounts_retention_idx"
  ON "library_accounts"("retain_until");

CREATE TABLE IF NOT EXISTS "library_sync_receipts" (
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "batch_id" TEXT NOT NULL,
  "cursor" INTEGER NOT NULL,
  "accepted" INTEGER NOT NULL,
  "created_at" INTEGER NOT NULL,
  PRIMARY KEY("user_id", "batch_id")
);
