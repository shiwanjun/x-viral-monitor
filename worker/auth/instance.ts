// ─────────────────────────────────────────────────────────────────────
// Better Auth instance factory — creates a per-request auth instance
// with env bindings injected.
//
// Better Auth 1.5+ natively supports Cloudflare D1: pass the D1 binding
// directly as `database` and it auto-detects SQLite, using D1's batch()
// API for atomicity. No Drizzle adapter needed.
// ─────────────────────────────────────────────────────────────────────

import { betterAuth } from "better-auth";
import { betterAuthOptions } from "./options";

export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ALLOWED_ORIGIN: string;
  EXTENSION_IDS?: string;
}

/** Build a Better Auth instance bound to the current request's env. */
export function createAuth(env: AuthEnv) {
  const trustedOrigins = String(env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return betterAuth({
    ...betterAuthOptions,
    database: env.DB,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    trustedOrigins,
  });
}

export type Auth = ReturnType<typeof createAuth>;
