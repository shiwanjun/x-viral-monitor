// ─────────────────────────────────────────────────────────────────────
// Better Auth configuration options.
//
// These are the STATIC options (things that don't depend on per-request
// env bindings). Per-request values (database, baseURL, secret, OAuth
// credentials) are injected by createAuth() in instance.ts.
// ─────────────────────────────────────────────────────────────────────

import type { BetterAuthOptions } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";

/**
 * The extension uses the Bearer plugin instead of cookies — cross-origin
 * cookies between chrome-extension:// and workers.dev don't work reliably.
 * After Google OAuth completes, Better Auth returns a `set-auth-token`
 * response header; the extension captures it and sends it back as
 * `Authorization: Bearer <token>` on subsequent API calls.
 */
export const betterAuthOptions: BetterAuthOptions = {
  appName: "X-Tools",
  basePath: "/api/auth",
  plugins: [bearer()],

  socialProviders: {
    google: {
      // clientId/clientSecret injected per-env in instance.ts
      clientId: "",
      clientSecret: "",
    },
  },

  // The extension origin must be trusted for cross-origin authenticated
  // requests. The actual origin list comes from env.ALLOWED_ORIGIN and is
  // merged in createAuth().
  trustedOrigins: [],

  // Users don't self-register via email/password — only Google OAuth.
  emailAndPassword: {
    enabled: false,
  },
};
