-- ─────────────────────────────────────────────────────────────────────
-- X-Tools Auth Worker — D1 schema
--
-- Run with:
--   npx wrangler d1 execute xtool --local  --file=./auth/schema.sql
--   npx wrangler d1 execute xtool --remote --file=./auth/schema.sql
--
-- Tables 1-4 are Better Auth's standard schema (for D1/SQLite adapter).
-- Table 5 (subscriptions) is X-Tools-specific, linking Better Auth users to
-- their Waffo subscription state.
-- ─────────────────────────────────────────────────────────────────────

-- 1. users ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "user" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "name"        TEXT NOT NULL,
  "email"       TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,  -- boolean (0/1)
  "image"       TEXT,
  "createdAt"   TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt"   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. sessions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "session" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "expiresAt"   TEXT NOT NULL,
  "token"       TEXT NOT NULL UNIQUE,
  "createdAt"   TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt"   TEXT NOT NULL DEFAULT (datetime('now')),
  "ipAddress"   TEXT,
  "userAgent"   TEXT,
  "userId"      TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId");

-- 3. accounts (OAuth provider links) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS "account" (
  "id"                TEXT PRIMARY KEY NOT NULL,
  "accountId"         TEXT NOT NULL,
  "providerId"        TEXT NOT NULL,
  "userId"            TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken"       TEXT,
  "refreshToken"      TEXT,
  "idToken"           TEXT,
  "accessTokenExpiresAt" TEXT,
  "refreshTokenExpiresAt" TEXT,
  "scope"             TEXT,
  "password"          TEXT,
  "createdAt"         TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt"         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"("userId");

-- 4. verification (email/OAuth verification tokens) ──────────────────
CREATE TABLE IF NOT EXISTS "verification" (
  "id"          TEXT PRIMARY KEY NOT NULL,
  "identifier"  TEXT NOT NULL,
  "value"       TEXT NOT NULL,
  "expiresAt"   TEXT NOT NULL,
  "createdAt"   TEXT DEFAULT (datetime('now')),
  "updatedAt"   TEXT DEFAULT (datetime('now'))
);

-- 5. subscriptions (X-Tools-specific) ────────────────────────────────────
--    One row per user, updated by Waffo webhooks.
CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id"                  TEXT PRIMARY KEY NOT NULL,           -- uuid
  "user_id"             TEXT NOT NULL UNIQUE REFERENCES "user"("id") ON DELETE CASCADE,
  "email"               TEXT NOT NULL,                       -- buyer email from Waffo
  "plan"                TEXT NOT NULL DEFAULT 'none',        -- standard | pro | max | none
  "status"              TEXT NOT NULL DEFAULT 'none',        -- active | canceling | canceled | past_due | none
  "waffo_order_id"      TEXT,                                -- ORD_xxx from Waffo
  "waffo_product_id"    TEXT,                                -- PROD_xxx
  "current_period_end"  INTEGER,                             -- ms epoch, null if no active sub
  "created_at"          TEXT NOT NULL DEFAULT (datetime('now')),
  "updated_at"          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS "subscriptions_email_idx" ON "subscriptions"("email");
CREATE INDEX IF NOT EXISTS "subscriptions_waffo_order_id_idx" ON "subscriptions"("waffo_order_id");

-- 6. webhook_dedup (idempotent webhook processing) ───────────────────
CREATE TABLE IF NOT EXISTS "webhook_dedup" (
  "delivery_id"  TEXT PRIMARY KEY NOT NULL,    -- event.id from Waffo
  "event_type"   TEXT NOT NULL,
  "processed_at" TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 7. optional follow-radar cloud history ──────────────────────────────
-- The extension never uploads X cookies, credentials, or page contents.
-- Each record contains only a locally detected public relationship event.
CREATE TABLE IF NOT EXISTS "follow_radar_events" (
  "id"               TEXT PRIMARY KEY NOT NULL,
  "user_id"          TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "event_id"         TEXT NOT NULL,
  "handle"           TEXT NOT NULL,
  "display_name"     TEXT NOT NULL DEFAULT '',
  "event_type"       TEXT NOT NULL CHECK ("event_type" IN ('unfollowed_me', 'i_unfollowed')),
  "occurred_at"      INTEGER NOT NULL,
  "followers_count"  INTEGER,
  "following_count"  INTEGER,
  "created_at"       TEXT NOT NULL DEFAULT (datetime('now')),
  "updated_at"       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE("user_id", "event_id")
);
CREATE INDEX IF NOT EXISTS "follow_radar_events_user_time_idx"
  ON "follow_radar_events"("user_id", "occurred_at" DESC);

-- 8. extension_handoffs ──────────────────────────────────────────────
-- One-time codes bridge a browser session on the public website to the
-- installed extension. The raw code never reaches D1: only its SHA-256
-- digest is retained. `consumed_at` makes redemption single-use.
CREATE TABLE IF NOT EXISTS "extension_handoffs" (
  "code_hash"    TEXT PRIMARY KEY NOT NULL,
  "user_id"      TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "extension_id" TEXT NOT NULL,
  "expires_at"   INTEGER NOT NULL,
  "consumed_at"  INTEGER,
  "created_at"   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS "extension_handoffs_expiry_idx"
  ON "extension_handoffs"("expires_at");

-- 9. 数据中心云备份清单（D1 仅保存索引，不承载大正文） ───────────────
CREATE TABLE IF NOT EXISTS "library_accounts" (
  "user_id"      TEXT PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "x_account_id" TEXT NOT NULL,
  "bound_at"     INTEGER NOT NULL,
  "retain_until" INTEGER,
  "updated_at"   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "library_sync_manifests" (
  "user_id"      TEXT PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "x_account_id" TEXT NOT NULL,
  "cursor"       INTEGER NOT NULL DEFAULT 0,
  "change_count" INTEGER NOT NULL DEFAULT 0,
  "bytes_used"   INTEGER NOT NULL DEFAULT 0,
  "updated_at"   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "library_sync_chunks" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "user_id"      TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "x_account_id" TEXT NOT NULL,
  "object_key"   TEXT NOT NULL UNIQUE,
  "cursor"       INTEGER NOT NULL,
  "change_count" INTEGER NOT NULL,
  "bytes_used"   INTEGER NOT NULL,
  "created_at"   INTEGER NOT NULL,
  UNIQUE("user_id", "cursor")
);
CREATE INDEX IF NOT EXISTS "library_sync_chunks_user_cursor_idx"
  ON "library_sync_chunks"("user_id", "cursor");
CREATE INDEX IF NOT EXISTS "library_accounts_retention_idx"
  ON "library_accounts"("retain_until");

CREATE TABLE IF NOT EXISTS "library_sync_receipts" (
  "user_id"    TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "batch_id"   TEXT NOT NULL,
  "cursor"     INTEGER NOT NULL,
  "accepted"   INTEGER NOT NULL,
  "created_at" INTEGER NOT NULL,
  PRIMARY KEY("user_id", "batch_id")
);
