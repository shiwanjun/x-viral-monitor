# ADR-0005: Waffo Subscription + Better Auth (Google Login) Architecture

Status: Proposed
Date: 2026-08-10
Supersedes: ADR-0004

## Context

The product requires:

1. **Account-based identity** — users log in with Google, subscriptions bind
   to their account rather than a device-local license key string.
2. **Three subscription tiers** — Standard ($3.99), Pro ($5.99), Max ($7.99),
   each unlocking progressively more features.
3. **Self-service subscription management** — users manage/cancel via the
   Waffo customer portal without contacting support.

Waffo Pancake provides the Merchant-of-Record payment + subscription
infrastructure; Better Auth provides the authentication layer (Google OAuth).

## Decision

Use the following subscription architecture:

### Backend: Cloudflare Worker "xtool" (Hono + D1)

- **Better Auth** (1.5+) handles Google OAuth login, session management, and
  user records in D1 (native D1 support — `database: env.DB`).
- **Bearer plugin** — the extension authenticates with `Authorization: Bearer
  <token>` instead of cookies (cross-origin cookies between
  `chrome-extension://` and `workers.dev` are unreliable). The token is
  obtained after OAuth and stored in `chrome.storage.local`.
- **Waffo REST API** — checkout sessions created server-side via WebCrypto
  RSA-SHA256 signing (the `@waffo/pancake-ts` SDK cannot run on Workers due
  to its `node:crypto` dependency; the signing is reimplemented in pure
  WebCrypto).
- **Waffo webhooks** — subscription lifecycle events (`subscription.activated`,
  `.payment_succeeded`, `.canceling`, `.canceled`, `.past_due`) update the
  `subscriptions` table in D1. Verified via RSA-SHA256 with the Waffo
  platform public key.

### Frontend: Extension subscription layer

- **Identity model**: Google login via Better Auth. The extension POSTs to the
  Worker's `/api/auth/sign-in/social` endpoint with `provider: "google"`; after
  OAuth completes, the bearer token is captured by `auth-callback.html` and stored.
- **Tier hierarchy**: `free < standard < pro < max`.
- **Gate API unchanged**: `window.__xvmPro.getCurrentTier()` /
  `isFeatureEnabled(name)` / `onTierChange(fn)` — feature modules are
  unaffected.

### Tier mapping

| Waffo product | Price | Tier | Unlocks |
|---------------|-------|------|---------|
| — | $0 | `free` | All existing free features |
| Standard | $3.99/mo | `standard` | + Velocity filter (basic) |
| Pro | $5.99/mo | `pro` | + Advanced thresholds, Pro leaderboard |
| Max | $7.99/mo | `max` | + All future premium features |

## Runtime Boundary

```
extension feature module
  → window.__xvmPro.isFeatureEnabled('rate-filter')
      → getCurrentTier()
          → current subscription status from the Worker
```

- Premium features depend only on `window.__xvmPro`.
- The extension bundle contains NO server secrets (Waffo private key, Google
  OAuth secret, Better Auth secret — all in Worker env).

## Storage

- `chrome.storage.local`:
  - `xvm_session_v1` — `{ token, userId, email, signedInAt }`
- D1 (Worker):
  - Better Auth tables: `user`, `session`, `account`, `verification`
  - `subscriptions` — `{ id, user_id, email, plan, status, waffo_order_id, current_period_end }`
  - `webhook_dedup` — idempotent webhook processing

## Threat Model

Accepted risks (same as ADR-0004):
- Open-source users can patch the runtime gate locally.
- Runtime checks can be bypassed by a determined user with DevTools.

Mitigated risks:
- **API key extraction**: Waffo private key + Google OAuth secret stay in
  Worker env (never in the extension bundle).
- **Forged webhooks**: RSA-SHA256 signature verification with Waffo platform
  public key + 5-minute replay window.
- **Accidental unlock**: feature modules only query one gate.

## Consequences

Positive:
- Users get account-based login (Google).
- Three pricing tiers enable better monetization.
- Self-service portal reduces support load.

Tradeoffs:
- More complex backend (D1 + Better Auth + Waffo).
- Webhook handling adds operational surface.
- The `@waffo/pancake-ts` SDK is not usable on Workers (pure-WebCrypto
  reimplementation required for signing + verification).
