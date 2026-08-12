X-Tools secrets
===========

This directory is ignored by git (`secrets/*` in `.gitignore`).

Environment files (root)
------------------------
After the Waffo subscription + Better Auth migration, secrets live in
versioned `.env` files at the repo root (all git-ignored except `.env.example`):

- `.env.example` — template with placeholders only. Safe to commit. Copy to start.
- `.env.test` — TEST environment (Waffo test keys, local dev). **git-ignored.**
- `.env.production` — PRODUCTION environment. **git-ignored.**

Variables in each `.env`:
- `BETTER_AUTH_SECRET` — session signing secret (`openssl rand -base64 32`)
- `BETTER_AUTH_URL` — Worker base URL (used for Google OAuth callback)
- `BETTER_AUTH_API_KEY` — optional Better Auth Infrastructure key; the D1-backed Google OAuth flow does not require it
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth credentials
- `WAFFO_MERCHANT_ID` / `WAFFO_STORE_ID` — Waffo merchant/store IDs
- `WAFFO_PRIVATE_KEY` — RSA PKCS#8 private key (PEM) for signing Waffo API requests
- `WAFFO_WEBHOOK_PUBLIC_KEY` — Waffo platform public key (PEM) for webhook verification
- `WAFFO_PRODUCT_STANDARD` / `_PRO` / `_MAX` — Waffo subscription product IDs
- `ALLOWED_ORIGIN` — comma-separated extension origins for CORS

Worker local dev
----------------
- `worker/.dev.vars` — copy of `.env.test` values for `wrangler dev`. **git-ignored.**
- `worker/.dev.vars.example` — template (safe to commit).

Never commit private keys, API keys, or OAuth secrets.
