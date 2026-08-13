// ─────────────────────────────────────────────────────────────────────
// X-Tools Auth Worker — Hono entry point.
//
// Deploys as "xtool" on Cloudflare Workers:
//   https://x.jieyiai.dev  (test and production both use this domain)
//
// Routes:
//   ALL  /api/auth/*            → Better Auth (login/callback/session)
//   POST /api/checkout/start    → Create Waffo checkout session (auth)
//   GET  /api/subscription/status → Current tier/plan (auth)
//   POST /api/webhook           → Waffo webhook receiver (signed)
// ─────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import { serializeSignedCookie } from "better-call";
import { createAuth, type AuthEnv } from "../auth/instance";
import {
  createCheckoutSession,
  type WaffoConfig,
} from "../lib/waffo-sign";
import {
  verifyWaffoWebhook,
  classifyEvent,
  type WaffoWebhookEvent,
} from "../lib/waffo-webhook";

// ─── Plan → tier mapping ─────────────────────────────────────────────
const PLAN_TO_TIER: Record<string, string> = {
  // Preserve access for customers on a retired tier during the migration.
  standard: "pro",
  pro: "pro",
  max: "pro",
  none: "free",
};

// ─── Env shape ───────────────────────────────────────────────────────
interface WorkerEnv extends AuthEnv {
  WAFFO_MERCHANT_ID: string;
  WAFFO_STORE_ID: string;
  WAFFO_PRIVATE_KEY: string;
  WAFFO_WEBHOOK_PUBLIC_KEY: string;
  WAFFO_ENV: string;
  WAFFO_PRODUCT_MEMBERSHIP_MONTHLY: string;
  WAFFO_PRODUCT_MEMBERSHIP_YEARLY: string;
  EXTENSION_IDS?: string;
  LIBRARY_WORKSPACE_ENABLED?: string;
  LIBRARY_BUCKET: R2Bucket;
}

const app = new Hono<{ Bindings: WorkerEnv }>();
const HANDOFF_TTL_MS = 60_000;

function configured(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function allowedExtensionIds(env: WorkerEnv) {
  return String(env.EXTENSION_IDS || "")
    .split(",").map((id) => id.trim()).filter((id) => /^[a-p]{32}$/.test(id));
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function handoffCode() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function subscriptionPayload(row: { plan: string; status: string; current_period_end: number | null } | null) {
  const storedPlan = row?.plan || "none";
  const plan = PLAN_TO_TIER[storedPlan] === "pro" ? "pro" : "none";
  const status = (row?.status as "active" | "canceling" | "canceled" | "past_due" | "none") || "none";
  const expiresAt = row?.current_period_end ?? null;
  const current = expiresAt == null || expiresAt > Date.now();
  return { tier: PLAN_TO_TIER[storedPlan] === "pro" && current && ["active", "canceling"].includes(status) ? "pro" : "free", plan, status, expiresAt };
}

// ─── CORS helper ─────────────────────────────────────────────────────
function corsHeaders(env: WorkerEnv, requestOrigin: string): Record<string, string> {
  const allowed = String(env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allow = allowed.includes("*")
    ? "*"
    : allowed.includes(requestOrigin)
      ? requestOrigin
      : allowed[0] || "null";
  const canUseCredentials = allow !== "*" && Boolean(requestOrigin && allowed.includes(requestOrigin));
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Expose-Headers": "set-auth-token",
    ...(canUseCredentials ? { "Access-Control-Allow-Credentials": "true" } : {}),
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withCors(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

type FollowRadarAccess = { userId: string; mode: "full" | "last_30_days" };
type LibraryAccess = { userId: string; accountId: string | null; mode: "full" | "read_only" | "none"; retainUntil: number | null };

async function libraryAccess(c: { env: WorkerEnv; req: { raw: Request } }, requestedAccountId = ""): Promise<LibraryAccess | null> {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const subscription = await c.env.DB.prepare("SELECT plan, status, current_period_end, updated_at FROM subscriptions WHERE user_id = ?")
    .bind(session.user.id).first<{ plan: string; status: string; current_period_end: number | null; updated_at: string | null }>();
  const binding = await c.env.DB.prepare("SELECT x_account_id, retain_until FROM library_accounts WHERE user_id = ?")
    .bind(session.user.id).first<{ x_account_id: string; retain_until: number | null }>();
  const active = PLAN_TO_TIER[subscription?.plan || "none"] === "pro"
    && ["active", "canceling"].includes(subscription?.status || "")
    && (subscription?.current_period_end == null || subscription.current_period_end > Date.now());
  if (requestedAccountId && binding?.x_account_id && requestedAccountId !== binding.x_account_id) {
    return { userId: session.user.id, accountId: binding.x_account_id, mode: "none", retainUntil: binding.retain_until };
  }
  if (active) return { userId: session.user.id, accountId: binding?.x_account_id || null, mode: "full", retainUntil: binding?.retain_until || null };
  const anchor = binding?.retain_until || (subscription?.current_period_end ? subscription.current_period_end + 30 * 24 * 60 * 60 * 1000 : null);
  if (anchor && anchor > Date.now()) return { userId: session.user.id, accountId: binding?.x_account_id || null, mode: "read_only", retainUntil: anchor };
  return { userId: session.user.id, accountId: binding?.x_account_id || null, mode: "none", retainUntil: anchor };
}

async function gzipJson(value: unknown): Promise<ArrayBuffer> {
  const source = new Blob([JSON.stringify(value)]).stream();
  const compressed = source.pipeThrough(new CompressionStream("gzip"));
  return new Response(compressed).arrayBuffer();
}

async function gunzipJson(body: ReadableStream): Promise<unknown> {
  const decompressed = body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressed).json();
}

/** The extension scans X locally; this accepts only public relationship events. */
async function getFollowRadarAccess(c: { env: WorkerEnv; req: { raw: Request } }, allowGrace = false): Promise<FollowRadarAccess | null> {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  const row = await c.env.DB.prepare(
    "SELECT plan, status, current_period_end, updated_at FROM subscriptions WHERE user_id = ?",
  ).bind(session.user.id).first<{ plan: string; status: string; current_period_end: number | null; updated_at: string | null }>();
  const memberPlan = PLAN_TO_TIER[row?.plan || "none"] === "pro";
  const current = row?.current_period_end == null || row.current_period_end > Date.now();
  if (memberPlan && current && ["active", "canceling"].includes(row?.status || "")) return { userId: session.user.id, mode: "full" };
  if (allowGrace && row && ["canceling", "canceled", "past_due"].includes(row.status || "")) {
    // A canceling subscription retains its period end. Revocation webhooks
    // clear it, so use the webhook update time as the fallback grace anchor.
    const graceAnchor = row.current_period_end ?? Date.parse(`${row.updated_at || ''}Z`);
    if (Number.isFinite(graceAnchor) && Date.now() >= graceAnchor && Date.now() - graceAnchor <= 30 * 24 * 60 * 60 * 1000) {
      return { userId: session.user.id, mode: "last_30_days" };
    }
  }
  return null;
}

function jsonWithCors(c: any, body: unknown, status = 200) {
  return c.json(body, status, corsHeaders(c.env, c.req.header("Origin") || ""));
}

// ─── Better Auth: /api/auth/* ────────────────────────────────────────
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  const auth = createAuth(c.env);
  const response = await auth.handler(c.req.raw);
  return withCors(response, corsHeaders(c.env, c.req.header("Origin") || ""));
});

// ─── Website → extension handoff ────────────────────────────────────
// The browser website has a first-party Better Auth cookie. It may mint a
// code for an installed, allow-listed extension; the extension exchanges the
// code for its own bearer token. No bearer token is sent to page JavaScript.
app.get("/api/extension-handoff/config", (c) => {
  // Extension IDs are public browser identifiers, not credentials. Returning
  // the configured list lets the test Worker hand off to an unpacked build
  // without ever widening the production site's fixed Web Store allowlist.
  return jsonWithCors(c, { extensionIds: allowedExtensionIds(c.env), libraryWorkspaceEnabled: c.env.LIBRARY_WORKSPACE_ENABLED !== "false" });
});

app.post("/api/extension-handoff/create", async (c) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return jsonWithCors(c, { ok: false, error: "unauthorized" }, 401);
  let body: { extensionId?: unknown };
  try { body = await c.req.json(); } catch (_) { return jsonWithCors(c, { ok: false, error: "invalid_json" }, 400); }
  const extensionId = String(body.extensionId || "");
  if (!allowedExtensionIds(c.env).includes(extensionId)) return jsonWithCors(c, { ok: false, error: "extension_not_allowed" }, 403);
  const code = handoffCode();
  const expiresAt = Date.now() + HANDOFF_TTL_MS;
  await c.env.DB.prepare("INSERT INTO extension_handoffs (code_hash, user_id, extension_id, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(code), session.user.id, extensionId, expiresAt).run();
  return jsonWithCors(c, { ok: true, code, expiresAt });
});

app.post("/api/extension-handoff/exchange", async (c) => {
  let body: { code?: unknown; extensionId?: unknown };
  try { body = await c.req.json(); } catch (_) { return jsonWithCors(c, { ok: false, error: "invalid_json" }, 400); }
  const code = String(body.code || "");
  const extensionId = String(body.extensionId || "");
  if (!/^[a-f0-9]{64}$/.test(code) || !allowedExtensionIds(c.env).includes(extensionId)) return jsonWithCors(c, { ok: false, error: "invalid_handoff" }, 400);
  const now = Date.now();
  const hash = await sha256(code);
  // D1 UPDATE is atomic: exactly one concurrent exchange can mark the code.
  const consumed = await c.env.DB.prepare("UPDATE extension_handoffs SET consumed_at = ? WHERE code_hash = ? AND extension_id = ? AND consumed_at IS NULL AND expires_at > ?")
    .bind(now, hash, extensionId, now).run();
  if ((consumed.meta?.changes || 0) !== 1) return jsonWithCors(c, { ok: false, error: "handoff_expired_or_used" }, 401);
  const handoff = await c.env.DB.prepare("SELECT user_id FROM extension_handoffs WHERE code_hash = ?").bind(hash).first<{ user_id: string }>();
  if (!handoff) return jsonWithCors(c, { ok: false, error: "handoff_missing" }, 401);
  const user = await c.env.DB.prepare('SELECT id, email, name FROM "user" WHERE id = ?').bind(handoff.user_id).first<{ id: string; email: string; name: string }>();
  const session = await c.env.DB.prepare('SELECT token FROM "session" WHERE userId = ? AND expiresAt > ? ORDER BY updatedAt DESC LIMIT 1')
    .bind(handoff.user_id, new Date(now).toISOString()).first<{ token: string }>();
  if (!user || !session) return jsonWithCors(c, { ok: false, error: "session_unavailable" }, 401);
  const signed = await serializeSignedCookie("", session.token, c.env.BETTER_AUTH_SECRET);
  // Match Better Auth's bearer plugin exactly: it signs the raw session token
  // through the cookie helper, then removes the synthetic empty-cookie prefix.
  const token = signed.replace("=", "");
  const subscription = subscriptionPayload(await c.env.DB.prepare("SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = ?").bind(user.id).first<{ plan: string; status: string; current_period_end: number | null }>());
  return jsonWithCors(c, { ok: true, token, user: { id: user.id, email: user.email, name: user.name }, subscription });
});

// ─── POST /api/checkout/start ────────────────────────────────────────
//   Body: { interval: "monthly" | "yearly" }
//   Requires: Bearer token (Better Auth session)
//   Returns: { checkoutUrl }
app.post("/api/checkout/start", async (c) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ ok: false, error: "unauthorized" }, 401, corsHeaders(c.env, c.req.header("Origin") || ""));
  }

  const body = await c.req.json<{ interval?: string }>();
  const interval = body?.interval;
  const productId = interval === "monthly" ? c.env.WAFFO_PRODUCT_MEMBERSHIP_MONTHLY
    : interval === "yearly" ? c.env.WAFFO_PRODUCT_MEMBERSHIP_YEARLY
    : null;
  if (!productId) {
    const configurationMissing = !configured(c.env.WAFFO_PRODUCT_MEMBERSHIP_MONTHLY)
      || !configured(c.env.WAFFO_PRODUCT_MEMBERSHIP_YEARLY)
      || !configured(c.env.WAFFO_MERCHANT_ID)
      || !configured(c.env.WAFFO_PRIVATE_KEY);
    return c.json({
      ok: false,
      error: configurationMissing ? "payments_not_configured" : "invalid_plan",
    }, configurationMissing ? 503 : 400, corsHeaders(c.env, c.req.header("Origin") || ""));
  }

  if (!configured(c.env.WAFFO_MERCHANT_ID) || !configured(c.env.WAFFO_PRIVATE_KEY)) {
    return c.json({ ok: false, error: "payments_not_configured" }, 503, corsHeaders(c.env, c.req.header("Origin") || ""));
  }

  const waffoConfig: WaffoConfig = {
    merchantId: c.env.WAFFO_MERCHANT_ID,
    privateKey: c.env.WAFFO_PRIVATE_KEY,
  };

  try {
    const session_data = await createCheckoutSession({
      productId,
      currency: "USD",
      buyerEmail: session.user.email,
      metadata: {
        userId: session.user.id,
        email: session.user.email,
        // Both products unlock the same membership tier.  The interval is
        // retained solely to calculate the local subscription period.
        plan: "pro",
        interval: interval!,
      },
      // successUrl: user returns to the extension via chrome-extension://...
    }, waffoConfig);

    return c.json({ ok: true, checkoutUrl: session_data.checkoutUrl, sessionId: session_data.sessionId }, 200, corsHeaders(c.env, c.req.header("Origin") || ""));
  } catch (e) {
    return c.json({ ok: false, error: "checkout_failed", detail: String((e as Error)?.message || e) }, 502, corsHeaders(c.env, c.req.header("Origin") || ""));
  }
});

// ─── GET /api/subscription/status ────────────────────────────────────
//   Requires: Bearer token
//   Returns: { tier, plan, status, expiresAt }
app.get("/api/subscription/status", async (c) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ ok: false, error: "unauthorized" }, 401, corsHeaders(c.env, c.req.header("Origin") || ""));
  }

  // Query D1 for the user's subscription row.
  const row = await c.env.DB.prepare(
    "SELECT plan, status, current_period_end FROM subscriptions WHERE user_id = ?",
  ).bind(session.user.id).first<{ plan: string; status: string; current_period_end: number | null }>();

  return c.json({ ok: true, ...subscriptionPayload(row) }, 200, corsHeaders(c.env, c.req.header("Origin") || ""));
});

// ─── Follow-radar cloud history (optional membership sync) ──────────
// No X session data, cookies, or page content are accepted here. Data is
// queried and deleted exclusively by the authenticated Better Auth user.
app.get("/api/follow-radar/events", async (c) => {
  const access = await getFollowRadarAccess(c, true);
  if (!access) return jsonWithCors(c, { ok: false, error: "membership_required" }, 403);
  const requested = Number.parseInt(c.req.query("limit") || "200", 10);
  const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 200, 1000));
  const since = access.mode === "last_30_days" ? Date.now() - 30 * 24 * 60 * 60 * 1000 : 0;
  const query = since
    ? "SELECT event_id, handle, display_name, event_type, occurred_at, followers_count, following_count FROM follow_radar_events WHERE user_id = ? AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?"
    : "SELECT event_id, handle, display_name, event_type, occurred_at, followers_count, following_count FROM follow_radar_events WHERE user_id = ? ORDER BY occurred_at DESC LIMIT ?";
  const statement = since ? c.env.DB.prepare(query).bind(access.userId, since, limit) : c.env.DB.prepare(query).bind(access.userId, limit);
  const rows = await statement.all<{ event_id: string; handle: string; display_name: string; event_type: string; occurred_at: number; followers_count: number | null; following_count: number | null }>();
  return jsonWithCors(c, {
    ok: true, retention: access.mode,
    events: (rows.results || []).map((event) => ({
      eventId: event.event_id, handle: event.handle, displayName: event.display_name,
      eventType: event.event_type, occurredAt: event.occurred_at,
      followersCount: event.followers_count, followingCount: event.following_count,
    })),
  });
});

app.post("/api/follow-radar/events", async (c) => {
  const access = await getFollowRadarAccess(c);
  if (!access) return jsonWithCors(c, { ok: false, error: "membership_required" }, 403);
  let body: { events?: unknown[] };
  try { body = await c.req.json<{ events?: unknown[] }>(); } catch (_) { return jsonWithCors(c, { ok: false, error: "invalid_json" }, 400); }
  if (!Array.isArray(body.events) || body.events.length > 1000) return jsonWithCors(c, { ok: false, error: "invalid_events" }, 400);

  let accepted = 0;
  for (const raw of body.events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    const handle = String(event.h ?? event.handle ?? "").replace(/^@/, "").trim().slice(0, 64);
    const type = String(event.type ?? event.eventType ?? "");
    const occurredAt = Number(event.ts ?? event.occurredAt);
    if (!handle || !["unfollowed_me", "i_unfollowed"].includes(type) || !Number.isFinite(occurredAt)) continue;
    const eventId = String(event.id ?? `${type}:${handle}:${occurredAt}`).slice(0, 180);
    const displayName = String(event.n ?? event.displayName ?? "").slice(0, 160);
    const followers = Number(event.fc ?? event.followersCount);
    const following = Number(event.fd ?? event.followingCount);
    await c.env.DB.prepare(
      `INSERT INTO follow_radar_events (id, user_id, event_id, handle, display_name, event_type, occurred_at, followers_count, following_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, event_id) DO UPDATE SET handle = excluded.handle, display_name = excluded.display_name,
         event_type = excluded.event_type, occurred_at = excluded.occurred_at, followers_count = excluded.followers_count,
         following_count = excluded.following_count, updated_at = datetime('now')`,
    ).bind(crypto.randomUUID(), access.userId, eventId, handle, displayName, type, Math.trunc(occurredAt), Number.isFinite(followers) ? Math.trunc(followers) : null, Number.isFinite(following) ? Math.trunc(following) : null).run();
    accepted += 1;
  }
  return jsonWithCors(c, { ok: true, accepted });
});

app.delete("/api/follow-radar/events", async (c) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return jsonWithCors(c, { ok: false, error: "unauthorized" }, 401);
  await c.env.DB.prepare("DELETE FROM follow_radar_events WHERE user_id = ?").bind(session.user.id).run();
  return jsonWithCors(c, { ok: true });
});

// ─── Library cloud backup (Pro, normalized metadata only) ───────────
app.get("/api/library/sync/status", async (c) => {
  const access = await libraryAccess(c);
  if (!access) return jsonWithCors(c, { ok: false, error: "unauthorized" }, 401);
  const manifest = await c.env.DB.prepare("SELECT cursor, change_count, bytes_used, updated_at FROM library_sync_manifests WHERE user_id = ?")
    .bind(access.userId).first<{ cursor: number; change_count: number; bytes_used: number; updated_at: string }>();
  return jsonWithCors(c, { ok: true, mode: access.mode, accountId: access.accountId, retainUntil: access.retainUntil, manifest: manifest || { cursor: 0, change_count: 0, bytes_used: 0, updated_at: null } });
});

app.post("/api/library/sync/push", async (c) => {
  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > 2 * 1024 * 1024) return jsonWithCors(c, { ok: false, error: "quota_exceeded" }, 413);
  let body: { accountId?: unknown; deviceId?: unknown; batchId?: unknown; cursor?: unknown; changes?: unknown[] };
  try { body = await c.req.json(); } catch (_) { return jsonWithCors(c, { ok: false, error: "invalid_json" }, 400); }
  const accountId = String(body.accountId || "").slice(0, 64);
  const deviceId = String(body.deviceId || "").slice(0, 80);
  const batchId = String(body.batchId || "").slice(0, 128);
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (!accountId || !deviceId || !batchId || !changes.length || changes.length > 500) return jsonWithCors(c, { ok: false, error: "invalid_request" }, 400);
  const access = await libraryAccess(c, accountId);
  if (!access) return jsonWithCors(c, { ok: false, error: "unauthorized" }, 401);
  if (access.mode !== "full") return jsonWithCors(c, { ok: false, error: access.accountId && access.accountId !== accountId ? "account_mismatch" : "membership_required" }, 403);

  const receipt = await c.env.DB.prepare("SELECT cursor, accepted FROM library_sync_receipts WHERE user_id = ? AND batch_id = ?")
    .bind(access.userId, batchId).first<{ cursor: number; accepted: number }>();
  if (receipt) return jsonWithCors(c, { ok: true, dedup: true, accepted: receipt.accepted, cursor: receipt.cursor });

  const expected = Math.max(0, Number(body.cursor) || 0);
  const current = await c.env.DB.prepare("SELECT cursor FROM library_sync_manifests WHERE user_id = ?").bind(access.userId).first<{ cursor: number }>();
  const currentCursor = Number(current?.cursor || 0);
  if (expected !== currentCursor) return jsonWithCors(c, { ok: false, error: "cursor_conflict", cursor: currentCursor }, 409);
  if (!access.accountId) {
    await c.env.DB.prepare("INSERT INTO library_accounts (user_id, x_account_id, bound_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at")
      .bind(access.userId, accountId, Date.now(), Date.now()).run();
  }
  const accepted = changes.filter((change) => change && typeof change === "object" && String((change as any).id || "").length <= 220).slice(0, 500);
  const nextCursor = currentCursor + 1;
  const objectKey = `library/${access.userId}/${accountId}/${String(nextCursor).padStart(12, "0")}-${crypto.randomUUID()}.json.gz`;
  const payload = { version: 1, accountId, deviceId, cursor: nextCursor, createdAt: Date.now(), changes: accepted };
  const compressed = await gzipJson(payload);
  if (compressed.byteLength > 2 * 1024 * 1024) return jsonWithCors(c, { ok: false, error: "quota_exceeded" }, 413);
  await c.env.LIBRARY_BUCKET.put(objectKey, compressed, { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" }, customMetadata: { userId: access.userId, accountId, cursor: String(nextCursor) } });
  const chunkId = crypto.randomUUID();
  const batch = c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO library_sync_chunks (id, user_id, x_account_id, object_key, cursor, change_count, bytes_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(chunkId, access.userId, accountId, objectKey, nextCursor, accepted.length, compressed.byteLength, Date.now()),
    c.env.DB.prepare(`INSERT INTO library_sync_manifests (user_id, x_account_id, cursor, change_count, bytes_used, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET cursor = excluded.cursor, x_account_id = excluded.x_account_id,
      change_count = library_sync_manifests.change_count + excluded.change_count, bytes_used = library_sync_manifests.bytes_used + excluded.bytes_used, updated_at = excluded.updated_at`)
      .bind(access.userId, accountId, nextCursor, accepted.length, compressed.byteLength, Date.now()),
    c.env.DB.prepare("INSERT INTO library_sync_receipts (user_id, batch_id, cursor, accepted, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(access.userId, batchId, nextCursor, accepted.length, Date.now()),
  ]);
  try { await batch; } catch (error) { await c.env.LIBRARY_BUCKET.delete(objectKey); throw error; }
  return jsonWithCors(c, { ok: true, accepted: accepted.length, cursor: nextCursor });
});

app.get("/api/library/sync/pull", async (c) => {
  const access = await libraryAccess(c);
  if (!access) return jsonWithCors(c, { ok: false, error: "unauthorized" }, 401);
  if (access.mode === "none") return jsonWithCors(c, { ok: false, error: "membership_required" }, 403);
  const cursor = Math.max(0, Number(c.req.query("cursor") || 0));
  const limit = Math.max(1, Math.min(50, Number(c.req.query("limit") || 10)));
  const rows = await c.env.DB.prepare("SELECT object_key, cursor FROM library_sync_chunks WHERE user_id = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?")
    .bind(access.userId, cursor, limit).all<{ object_key: string; cursor: number }>();
  const chunks = [];
  for (const row of rows.results || []) {
    const object = await c.env.LIBRARY_BUCKET.get(row.object_key);
    if (!object?.body) continue;
    chunks.push(await gunzipJson(object.body));
  }
  const nextCursor = (rows.results || []).at(-1)?.cursor || cursor;
  return jsonWithCors(c, { ok: true, mode: access.mode, cursor: nextCursor, hasMore: (rows.results || []).length === limit, chunks });
});

app.delete("/api/library/sync", async (c) => {
  const access = await libraryAccess(c);
  if (!access) return jsonWithCors(c, { ok: false, error: "unauthorized" }, 401);
  const rows = await c.env.DB.prepare("SELECT object_key FROM library_sync_chunks WHERE user_id = ?").bind(access.userId).all<{ object_key: string }>();
  const keys = (rows.results || []).map((row) => row.object_key);
  for (let offset = 0; offset < keys.length; offset += 1000) await c.env.LIBRARY_BUCKET.delete(keys.slice(offset, offset + 1000));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM library_sync_chunks WHERE user_id = ?").bind(access.userId),
    c.env.DB.prepare("DELETE FROM library_sync_manifests WHERE user_id = ?").bind(access.userId),
    c.env.DB.prepare("DELETE FROM library_sync_receipts WHERE user_id = ?").bind(access.userId),
    c.env.DB.prepare("DELETE FROM library_accounts WHERE user_id = ?").bind(access.userId),
  ]);
  return jsonWithCors(c, { ok: true, deletedChunks: keys.length });
});

// ─── POST /api/webhook ───────────────────────────────────────────────
//   Waffo webhook receiver. Verifies RSA-SHA256 signature, then updates
//   the subscriptions table based on the event type.
app.post("/api/webhook", async (c) => {
  const rawBody = await c.req.text();
  const sigHeader = c.req.header("X-Waffo-Signature") || "";

  const verify = await verifyWaffoWebhook(rawBody, sigHeader, c.env.WAFFO_WEBHOOK_PUBLIC_KEY);
  if (!verify.ok) {
    return c.json({ ok: false, error: verify.error }, 401);
  }

  const event = JSON.parse(rawBody) as WaffoWebhookEvent;

  // Idempotent dedup — skip if we've already processed this delivery.
  const dup = await c.env.DB.prepare(
    "INSERT INTO webhook_dedup (delivery_id, event_type) VALUES (?, ?) ON CONFLICT(delivery_id) DO NOTHING",
  ).bind(event.id, event.eventType).run();
  if (!dup.meta?.changes) {
    return c.json({ ok: true, dedup: true });
  }

  const action = classifyEvent(event.eventType);
  if (action === "ignore") {
    return c.json({ ok: true, ignored: true });
  }

  const meta = (event.data.orderMetadata || {}) as { userId?: string; email?: string; plan?: string; interval?: string };
  const userId = meta.userId;
  const email = event.data.buyerEmail || meta.email || "";
  const orderId = event.data.orderId;

  if (!userId && !email) {
    return c.json({ ok: true, skipped: "no_user_identity" });
  }

  // Resolve userId from email if metadata didn't carry it.
  let resolvedUserId: string | undefined = userId;
  if (!resolvedUserId && email) {
    const u = await c.env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first<{ id: string }>();
    resolvedUserId = u?.id;
  }
  if (!resolvedUserId) {
    return c.json({ ok: true, skipped: "user_not_found" });
  }

  const plan = "pro"; // a single paid membership tier
  const periodMs = meta.interval === "yearly"
    ? 365 * 24 * 60 * 60 * 1000
    : 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  if (action === "grant") {
    await c.env.DB.prepare(
      `INSERT INTO subscriptions (id, user_id, email, plan, status, waffo_order_id, current_period_end, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         plan = excluded.plan, status = 'active', waffo_order_id = excluded.waffo_order_id,
         current_period_end = excluded.current_period_end, updated_at = datetime('now')`,
    ).bind(crypto.randomUUID(), resolvedUserId, email, plan, orderId, now + periodMs).run();
    await c.env.DB.prepare("UPDATE library_accounts SET retain_until = NULL, updated_at = ? WHERE user_id = ?").bind(now, resolvedUserId).run();
  } else if (action === "ending") {
    // canceling — keep access until period end, mark status.
    await c.env.DB.prepare(
      "UPDATE subscriptions SET status = 'canceling', updated_at = datetime('now') WHERE user_id = ?",
    ).bind(resolvedUserId).run();
    const retainUntil = (await c.env.DB.prepare("SELECT current_period_end FROM subscriptions WHERE user_id = ?").bind(resolvedUserId).first<{ current_period_end: number | null }>())?.current_period_end;
    if (retainUntil) await c.env.DB.prepare("UPDATE library_accounts SET retain_until = ?, updated_at = ? WHERE user_id = ?")
      .bind(retainUntil + 30 * 24 * 60 * 60 * 1000, now, resolvedUserId).run();
  } else if (action === "revoke") {
    // canceled or past_due — revoke access.
    await c.env.DB.prepare(
      "UPDATE subscriptions SET status = ?, plan = 'none', current_period_end = NULL, updated_at = datetime('now') WHERE user_id = ?",
    ).bind(statusForEvent(event.eventType), resolvedUserId).run();
    await c.env.DB.prepare("UPDATE library_accounts SET retain_until = ?, updated_at = ? WHERE user_id = ?")
      .bind(now + 30 * 24 * 60 * 60 * 1000, now, resolvedUserId).run();
  }

  return c.json({ ok: true, action });
});

function statusForEvent(eventType: string): string {
  if (eventType === "subscription.past_due") return "past_due";
  return "canceled";
}

// ─── OPTIONS (CORS preflight) ────────────────────────────────────────
app.options("*", (c) => {
  return new Response(null, { status: 204, headers: corsHeaders(c.env, c.req.header("Origin") || "") });
});

async function cleanupExpiredLibraries(env: WorkerEnv) {
  const expired = await env.DB.prepare("SELECT user_id FROM library_accounts WHERE retain_until IS NOT NULL AND retain_until <= ? LIMIT 100")
    .bind(Date.now()).all<{ user_id: string }>();
  for (const account of expired.results || []) {
    const rows = await env.DB.prepare("SELECT object_key FROM library_sync_chunks WHERE user_id = ?").bind(account.user_id).all<{ object_key: string }>();
    const keys = (rows.results || []).map((row) => row.object_key);
    for (let offset = 0; offset < keys.length; offset += 1000) await env.LIBRARY_BUCKET.delete(keys.slice(offset, offset + 1000));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM library_sync_chunks WHERE user_id = ?").bind(account.user_id),
      env.DB.prepare("DELETE FROM library_sync_manifests WHERE user_id = ?").bind(account.user_id),
      env.DB.prepare("DELETE FROM library_sync_receipts WHERE user_id = ?").bind(account.user_id),
      env.DB.prepare("DELETE FROM library_accounts WHERE user_id = ?").bind(account.user_id),
    ]);
  }
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
    ctx.waitUntil(cleanupExpiredLibraries(env));
  },
};
