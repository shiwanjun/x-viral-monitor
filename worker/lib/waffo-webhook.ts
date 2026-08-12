// ─────────────────────────────────────────────────────────────────────
// Waffo webhook signature verification — pure WebCrypto.
//
// Waffo delivers webhooks with header:
//   X-Waffo-Signature: t=<timestamp-ms>,v1=<base64-RSA-SHA256-signature>
//
// The signature is computed over: `${t}.${rawRequestBody}`
// using RSA-SHA256 (PKCS#1 v1.5) with Waffo's platform-level public key
// (copied from Dashboard → Settings → Webhooks → Webhook Public Key).
//
// Verification steps (per Waffo docs):
//   1. Parse t and v1 from the header.
//   2. Build signature input: `${t}.${rawRequestBody}`
//   3. Verify v1 using RSA-SHA256 with the Waffo public key.
//   4. Check t is within 5 minutes of current time (replay protection).
//
// CRITICAL: rawRequestBody must be the raw text (request.text()), NOT
// parsed-then-re-serialized JSON — re-serialization changes the bytes and
// breaks the signature.
// ─────────────────────────────────────────────────────────────────────

const REPLAY_TOLERANCE_MS = 5 * 60 * 1000;

let cachedKey: { pem: string; key: CryptoKey } | null = null;

/** Parse a PEM-encoded RSA public key (SPKI / X.509) into a CryptoKey. */
export async function importWaffoPublicKey(pem: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.pem === pem) return cachedKey.key;
  const normalized = pem
    .replace(/-----BEGIN[^-]*-----/g, "")
    .replace(/-----END[^-]*-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const key = await crypto.subtle.importKey(
    "spki",
    bytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  cachedKey = { pem, key };
  return key;
}

/** Parse the X-Waffo-Signature header into { t, v1 }. */
export function parseSignatureHeader(header: string): { t: string; v1: string } | null {
  const parts: Record<string, string> = {};
  for (const pair of header.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    parts[key] = val;
  }
  if (!parts.t || !parts.v1) return null;
  return { t: parts.t, v1: parts.v1 };
}

/** Base64 → Uint8Array (for decoding the signature). */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
}

/**
 * Verify a Waffo webhook.
 *
 * @param rawBody      - The raw request body text (request.text()).
 * @param sigHeader    - The X-Waffo-Signature header value.
 * @param publicKeyPem - Waffo platform public key (PEM).
 * @param now          - Current time in ms (injectable for tests).
 */
export async function verifyWaffoWebhook(
  rawBody: string,
  sigHeader: string,
  publicKeyPem: string,
  now: number = Date.now(),
): Promise<VerifyResult> {
  const parsed = parseSignatureHeader(sigHeader);
  if (!parsed) return { ok: false, error: "malformed_signature_header" };

  const timestampMs = Number(parsed.t);
  if (!Number.isFinite(timestampMs)) return { ok: false, error: "invalid_timestamp" };

  // Replay protection — 5 minute window per Waffo spec.
  if (Math.abs(now - timestampMs) > REPLAY_TOLERANCE_MS) {
    return { ok: false, error: "timestamp_outside_tolerance" };
  }

  const signatureInput = `${parsed.t}.${rawBody}`;
  const key = await importWaffoPublicKey(publicKeyPem);
  const sigBytes = base64ToBytes(parsed.v1);
  const dataBytes = new TextEncoder().encode(signatureInput);

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sigBytes,
    dataBytes,
  );
  return valid ? { ok: true } : { ok: false, error: "signature_mismatch" };
}

// ── Webhook event types & payload ───────────────────────────────────

export const WaffoEventType = {
  OrderCompleted: "order.completed",
  SubscriptionActivated: "subscription.activated",
  SubscriptionPaymentSucceeded: "subscription.payment_succeeded",
  SubscriptionCanceling: "subscription.canceling",
  SubscriptionUncanceled: "subscription.uncanceled",
  SubscriptionUpdated: "subscription.updated",
  SubscriptionCanceled: "subscription.canceled",
  SubscriptionPastDue: "subscription.past_due",
  RefundSucceeded: "refund.succeeded",
  RefundFailed: "refund.failed",
} as const;

export type WaffoEventType = (typeof WaffoEventType)[keyof typeof WaffoEventType];

export interface WaffoWebhookEvent {
  id: string; // delivery ID (for idempotent dedup)
  timestamp: string; // ISO 8601
  eventType: WaffoEventType | string;
  eventId: string; // business event ID (order/payment ID)
  storeId: string;
  storeName?: string;
  mode: string; // "test" | "prod"
  data: {
    orderId: string;
    orderStatus?: string;
    buyerEmail: string;
    currency: string;
    orderMetadata?: Record<string, unknown>;
    productMetadata?: Record<string, unknown>;
    amount: string;
    taxAmount?: string;
    productName?: string;
    paymentStatus?: string;
    paymentMethod?: string;
  };
}

/** Which webhook events should grant/extend subscription access. */
const ACCESS_GRANTING_EVENTS = new Set<string>([
  WaffoEventType.SubscriptionActivated,
  WaffoEventType.SubscriptionPaymentSucceeded,
  WaffoEventType.SubscriptionUncanceled,
  WaffoEventType.SubscriptionUpdated,
]);

/** Which webhook events should revoke or mark subscription as ending. */
const ACCESS_REVOKING_EVENTS = new Set<string>([
  WaffoEventType.SubscriptionCanceled,
  WaffoEventType.SubscriptionPastDue,
]);

/** Which webhook events mean subscription will end at period close. */
const ACCESS_ENDING_EVENTS = new Set<string>([
  WaffoEventType.SubscriptionCanceling,
]);

export function classifyEvent(eventType: string): "grant" | "revoke" | "ending" | "ignore" {
  if (ACCESS_GRANTING_EVENTS.has(eventType)) return "grant";
  if (ACCESS_REVOKING_EVENTS.has(eventType)) return "revoke";
  if (ACCESS_ENDING_EVENTS.has(eventType)) return "ending";
  return "ignore";
}
