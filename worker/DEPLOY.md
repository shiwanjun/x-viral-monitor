# X-Tools Auth Worker — Deployment Guide

The auth worker (`xtool`) runs on Cloudflare Workers and provides:
- **Better Auth** (Google OAuth login + session management) via D1
- **Waffo subscription** integration (checkout session creation, webhook processing)
- **Website-to-extension handoff** using a short-lived, one-time code

## URLs

| Env | URL |
|-----|-----|
| Test | `https://x.jieyiai.dev` |
| Prod | `https://x.jieyiai.dev` (same custom domain, different secrets/env) |

## Prerequisites

### 1. Cloudflare D1 database

```bash
npx wrangler d1 create xtool
```

Paste the returned `database_id` into `wrangler.auth.toml` (replace all `TODO_run_npx_wrangler_d1_create_xtool`).

### 2. Initialize the schema

```bash
cd worker
npx wrangler d1 execute xtool --remote --file=./auth/schema.sql
# For local dev:
npx wrangler d1 execute xtool --local --file=./auth/schema.sql
```

When upgrading an existing database, run the same schema command again. Its
`CREATE TABLE IF NOT EXISTS` statements add the `extension_handoffs` table
used to transfer a website login to the installed browser extension.

### 3. Install dependencies

```bash
cd worker
npm install
```

### 4. Set secrets

Copy values from your `.env.test` (or `.env.production`):

```bash
cd worker

npx wrangler secret put BETTER_AUTH_SECRET              -c wrangler.auth.toml
npx wrangler secret put GOOGLE_CLIENT_ID                -c wrangler.auth.toml
npx wrangler secret put GOOGLE_CLIENT_SECRET            -c wrangler.auth.toml
npx wrangler secret put WAFFO_MERCHANT_ID               -c wrangler.auth.toml
npx wrangler secret put WAFFO_STORE_ID                  -c wrangler.auth.toml
npx wrangler secret put WAFFO_PRIVATE_KEY               -c wrangler.auth.toml
npx wrangler secret put WAFFO_WEBHOOK_PUBLIC_KEY        -c wrangler.auth.toml
npx wrangler secret put WAFFO_PRODUCT_MEMBERSHIP_MONTHLY -c wrangler.auth.toml
npx wrangler secret put WAFFO_PRODUCT_MEMBERSHIP_YEARLY  -c wrangler.auth.toml
```

`EXTENSION_IDS` is a non-secret Worker variable. It must contain a comma-
separated allowlist of Chrome extension IDs that may receive login handoffs.
The checked-in configuration includes the Web Store ID. Add a development
unpacked-extension ID only in the test environment; never use `*`.

For production, add `--env production`:
```bash
npx wrangler secret put BETTER_AUTH_SECRET -c wrangler.auth.toml --env production
# ... repeat for each secret
```

### 5. Local dev

```bash
cd worker
cp .dev.vars.example .dev.vars   # fill from .env.test
npx wrangler dev -c wrangler.auth.toml
```

The Worker runs at `http://localhost:8787`.

## External setup

### Google Cloud Console

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Web application**
3. Add Authorized redirect URIs:
   - `https://x.jieyiai.dev/api/auth/callback/google`
4. Copy the **Client ID** and **Client Secret** into your `.env` files

### Waffo Dashboard

1. **API Keys** (API & Development): Download the RSA private key → `WAFFO_PRIVATE_KEY`
2. **Webhooks** (Settings → Webhooks):
   - Add webhook URL: `https://x.jieyiai.dev/api/webhook`
   - Copy the **Webhook Public Key** → `WAFFO_WEBHOOK_PUBLIC_KEY`
3. **Subscription Products**: Create two billing options for one membership:
   - X-Tools Membership (Monthly) — $5.99/mo → `WAFFO_PRODUCT_MEMBERSHIP_MONTHLY`
   - X-Tools Membership (Annual) — $57.50/year (20% off) → `WAFFO_PRODUCT_MEMBERSHIP_YEARLY`

   These can be created via the Dashboard, **or** with the bundled script
   (uses `@waffo/pancake-ts`, idempotent — safe to re-run). From `worker/`:

   ```bash
   npm run bootstrap:waffo                       # dry-run (default), reviews plan
   WAFFO_DRY_RUN= npm run bootstrap:waffo        # create + write PROD_* back to .env.test
   ```

   To target a different env file: `WAFFO_ENV_FILE=../.env.production npm run bootstrap:waffo`.

## Deploy

```bash
cd worker

# Test
npx wrangler deploy -c wrangler.auth.toml --env test

# Production
npx wrangler deploy -c wrangler.auth.toml --env production
```

## Verify

```bash
# Health check (should return a Better Auth error response, not 500)
curl https://x.jieyiai.dev/api/auth/ok

# Webhook endpoint (should return 401 without valid signature)
curl -X POST https://x.jieyiai.dev/api/webhook
```
