// ─────────────────────────────────────────────────────────────────────
// Waffo Pancake API request signing — pure WebCrypto, zero dependencies.
//
// Waffo uses RSA-SHA256 (PKCS#1 v1.5) to sign every API request. The
// official @waffo/pancake-ts SDK hard-depends on node:crypto (createSign),
// which Cloudflare Workers do not provide. This module reimplements the
// exact same signing canonical-form using the WebCrypto API, which Workers
// support natively.
//
// Canonical request format (from Waffo auth docs):
//   canonicalRequest = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + SHA256_BASE64(BODY)
//   signature = RSA-SHA256(canonicalRequest, privateKey)
//   X-Signature = Base64(signature)
//
// Headers on every request:
//   X-Merchant-Id:  MER_xxx
//   X-Timestamp:    <unix seconds>
//   X-Signature:    <base64 RSA-SHA256 signature>
//   Content-Type:   application/json
// ─────────────────────────────────────────────────────────────────────

const WAFFO_API_BASE = "https://api.waffo.ai";

/** A cached imported RSA private key, keyed by the PEM string. */
let cachedKey: { pem: string; key: CryptoKey } | null = null;

/**
 * Parse a PEM-encoded RSA private key (PKCS#8) into a DER Uint8Array.
 * Accepts keys with literal "\n" sequences (as stored in .env) or real
 * newlines, with or without header/footer.
 */
function pemToDer(pem: string): Uint8Array {
  const normalized = pem
    .replace(/-----BEGIN[^-]*-----/g, "")
    .replace(/-----END[^-]*-----/g, "")
    .replace(/\\n/g, "") // literal \n from .env
    .replace(/\s/g, ""); // real whitespace / newlines
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Import the RSA private key for signing (RSASSA-PKCS1-v1_5 + SHA-256). */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.pem === pem) return cachedKey.key;
  const der = pemToDer(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedKey = { pem, key };
  return key;
}

/** Compute SHA-256 of a string, return base64-encoded digest. */
async function sha256Base64(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64FromBytes(new Uint8Array(digest));
}

/** Base64-encode a byte array (standard, NOT url-safe — Waffo expects standard). */
function base64FromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Base64-encode a string. */
function base64FromString(text: string): string {
  return base64FromBytes(new TextEncoder().encode(text));
}

export interface WaffoConfig {
  merchantId: string;
  privateKey: string;
}

export interface SignedRequestInit {
  method: string;
  path: string; // e.g. "/v1/actions/checkout/create-session"
  body: unknown; // will be JSON.stringify'd
}

/**
 * Build the required Waffo auth headers for a signed request.
 * Returns { headers, bodyText } where bodyText is the canonical JSON
 * serialization (must be sent as the actual body so the signature matches).
 */
export async function buildSignedHeaders(
  req: SignedRequestInit,
  config: WaffoConfig,
): Promise<{ headers: Record<string, string>; bodyText: string }> {
  const bodyText = JSON.stringify(req.body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = await sha256Base64(bodyText);
  const canonicalRequest = `${req.method}\n${req.path}\n${timestamp}\n${bodyHash}`;

  const key = await importPrivateKey(config.privateKey);
  const signatureBytes = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(canonicalRequest),
  );
  const signature = base64FromBytes(new Uint8Array(signatureBytes));

  return {
    headers: {
      "Content-Type": "application/json",
      "X-Merchant-Id": config.merchantId,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    },
    bodyText,
  };
}

/**
 * Make a signed POST request to the Waffo API.
 * Throws on non-2xx with the parsed error body.
 */
export async function waffoPost<T = unknown>(
  path: string,
  body: unknown,
  config: WaffoConfig,
): Promise<T> {
  const { headers, bodyText } = await buildSignedHeaders(
    { method: "POST", path, body },
    config,
  );
  const res = await fetch(`${WAFFO_API_BASE}${path}`, {
    method: "POST",
    headers,
    body: bodyText,
  });
  const json = (await res.json()) as { data: T | null; errors?: Array<{ message: string }> };
  if (!res.ok || json.errors?.length) {
    const msg = json.errors?.[0]?.message ?? `Waffo API ${res.status}`;
    throw new Error(msg);
  }
  return json.data as T;
}

// ── Response types ──────────────────────────────────────────────────

export interface WaffoCheckoutSession {
  sessionId: string;
  checkoutUrl: string;
  expiresAt: string;
}

export interface WaffoCheckoutBody {
  productId: string;
  currency: string;
  successUrl?: string;
  buyerEmail?: string;
  metadata?: Record<string, string>;
  withTrial?: boolean;
  language?: string;
  darkMode?: boolean;
}

/** Create a Waffo checkout session. */
export async function createCheckoutSession(
  body: WaffoCheckoutBody,
  config: WaffoConfig,
): Promise<WaffoCheckoutSession> {
  return waffoPost<WaffoCheckoutSession>(
    "/v1/actions/checkout/create-session",
    body,
    config,
  );
}

// Exported for tests
export { pemToDer, sha256Base64, base64FromBytes, base64FromString, WAFFO_API_BASE };
