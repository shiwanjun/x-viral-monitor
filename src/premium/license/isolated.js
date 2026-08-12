// === XVM session bridge (ISOLATED world) — Waffo subscription + Better Auth ===
//
// Owns chrome.storage.local only for the Better Auth session. Calls the xtool
// Worker for the authoritative subscription status and pushes that tier to MAIN world via
// window.postMessage so gate.js can answer feature modules without touching
// chrome.storage or fetch.
//
// Architecture boundary:
//   - extension code contains NO server-side secret (Worker holds Waffo
//     private key, Better Auth secret, Google OAuth secret)
//   - no subscription result is cached or validated locally
//   - feature modules NEVER read session/storage directly — they only
//     receive postMessage updates routed through gate.js
//
// Message contract (event.data.type):
//   ← XVM_TIER_REQUEST                                    (from MAIN/gate.js on init)
//   → XVM_TIER_UPDATE { tier, daysLeft, source }          (to MAIN/gate.js)
//   ← XVM_AUTH_TOKEN { token, userId, email }             (from auth-callback/background)
//   → XVM_AUTH_TOKEN_RESULT { ok, tier?, error? }
//   ← XVM_SUB_STATUS_REQUEST
//   → XVM_SUB_STATUS { record, tier, daysLeft, source }
//   ← XVM_SIGN_OUT
//   → XVM_SIGN_OUT_RESULT { ok }
//   ← XVM_CHECKOUT_START { plan }                         (from popup)
//   → XVM_CHECKOUT_RESULT { ok, checkoutUrl?, error? }
//
// Worker deploys as "xtool" on Cloudflare:
//   https://x.jieyiai.dev  (custom domain — test and prod both use this)

(() => {
  if (window.__xvmLicenseBridge) return; // idempotent on hot reload
  window.__xvmLicenseBridge = true;

  // ─── Configuration ──────────────────────────────────────────────────
  // The auth backend (xtool Worker), reachable via the x.jieyiai.dev
  // custom domain. Both test and production use the same domain.
  const AUTH_BACKEND_URL = 'https://x.jieyiai.dev';

  // Tier mapping lives in tier-logic.js (loaded before us per manifest order).
  const TL = globalThis.__xvmTierLogic;
  if (!TL) {
    console.error('[xvm] tier-logic.js not loaded before isolated.js — manifest content_scripts order broken');
    return;
  }
  const { subscriptionStatusFrom } = TL;

  // Storage keys. Session replaces the old license_v1 record.
  const SESSION_KEY   = 'xvm_session_v1';   // { token, userId, email, signedInAt }
  const DEVICE_ID_KEY = 'xvm_device_id';
  const RATE_FILTER_KEY = 'xvm_rate_filter_v1';
  const CONTENT_FILTER_KEY = 'xvm_content_filter_v1';
  const CONTENT_FILTER_RULES_KEY = 'xvm_content_filter_rules_remote_v1';

  // Remote content-filter rules (unchanged from license-proxy era).
  const REMOTE_RULES_URL = 'https://raw.githubusercontent.com/Icy-Cat/x-viral-monitor/main/src/premium/content-filter/rules.json';
  const REMOTE_RULES_TTL_MS = 6 * 60 * 60 * 1000;
  const REMOTE_RULES_MIN_RETRY_MS = 5 * 60 * 1000;
  const REMOTE_RULES_SCHEMA_MAX = 2;
  const REMOTE_RULES_CURRENT_VERSION = 2;

  // ─── chrome.storage wrappers (best-effort no-op outside extension) ──
  function safeStorageGet(key, fallback) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.local) return resolve(fallback);
        chrome.storage.local.get(key, (o) => resolve(o?.[key] ?? fallback));
      } catch (_) { resolve(fallback); }
    });
  }
  function safeStorageSet(obj) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.local) return resolve();
        chrome.storage.local.set(obj, resolve);
      } catch (_) { resolve(); }
    });
  }
  function safeStorageRemove(key) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.storage?.local) return resolve();
        chrome.storage.local.remove(key, resolve);
      } catch (_) { resolve(); }
    });
  }

  // ─── Auth + subscription API calls (to xtool Worker) ────────────────
  // All calls use the Better Auth bearer token stored in the session record.
  // The token is obtained after Google OAuth completes (see auth-client.js
  // and auth-callback.html).
  function authedFetch(path, options = {}) {
    return safeStorageGet(SESSION_KEY, null).then((session) => {
      if (!session?.token) throw new Error('not_signed_in');
      const headers = { ...((options.headers) || {}), Authorization: `Bearer ${session.token}` };
      return fetch(`${AUTH_BACKEND_URL}${path}`, { ...options, headers });
    });
  }

  // Fetch the authoritative subscription status. Results deliberately stay
  // in memory: feature access must never depend on a local cache or signature.
  async function refreshSubscriptionStatus() {
    const session = await safeStorageGet(SESSION_KEY, null);
    if (!session?.token) return { ok: false, error: 'not_signed_in' };

    let res;
    try {
      res = await fetch(`${AUTH_BACKEND_URL}/api/subscription/status`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
    } catch (e) {
      return { ok: false, error: 'network', message: String(e?.message || e) };
    }
    if (res.status === 401) {
      // Token expired/invalid — clear session.
      await safeStorageRemove(SESSION_KEY);
      pushTier();
      return { ok: false, error: 'auth_expired' };
    }
    if (!res.ok) {
      return { ok: false, error: 'status_failed', status: res.status };
    }
    const data = await res.json();
    if (!data?.ok) return { ok: false, error: data?.error || 'unknown' };

    const record = {
      userId: session.userId,
      email: session.email,
      plan: data.plan,
      status: data.status,
      currentPeriodEnd: data.expiresAt,
    };
    return { ok: true, record };
  }

  // ─── Tier resolver ──────────────────────────────────────────────────
  async function getSubscriptionStatus() {
    const result = await refreshSubscriptionStatus();
    if (!result.ok) return { tier: 'free', source: result.error || 'unavailable' };
    return subscriptionStatusFrom(result.record, Date.now());
  }

  async function resolveTier() {
    const status = await getSubscriptionStatus();
    return { ...status, daysLeft: 0, record: null };
  }

  // ─── Auth operations ────────────────────────────────────────────────
  // Store a bearer token obtained after Google OAuth (from auth-callback).
  async function storeAuthToken(token, userId, email) {
    if (!token) return { ok: false, error: 'no_token' };
    const session = {
      token,
      userId: userId || null,
      email: email || null,
      signedInAt: Date.now(),
    };
    await safeStorageSet({ [SESSION_KEY]: session });
    pushTier();
    return { ok: true };
  }

  async function signOut() {
    await safeStorageRemove(SESSION_KEY);
    pushTier();
    return { ok: true };
  }

  // ─── Checkout ───────────────────────────────────────────────────────
  async function startCheckout(plan) {
    const session = await safeStorageGet(SESSION_KEY, null);
    if (!session?.token) return { ok: false, error: 'not_signed_in' };
    let res;
    try {
      res = await fetch(`${AUTH_BACKEND_URL}/api/checkout/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ plan }),
      });
    } catch (e) {
      return { ok: false, error: 'network', message: String(e?.message || e) };
    }
    const data = await res.json();
    if (!data?.ok) return { ok: false, error: data?.error || 'checkout_failed' };
    return { ok: true, checkoutUrl: data.checkoutUrl };
  }

  // ─── Push tier to MAIN world ────────────────────────────────────────
  async function pushTier() {
    const r = await resolveTier();
    window.postMessage({
      type: 'XVM_TIER_UPDATE',
      tier: r.tier,
      daysLeft: r.daysLeft,
      source: r.source,
    }, '*');
  }

  // ─── Message router ─────────────────────────────────────────────────
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const t = event.data?.type;
    if (t === 'XVM_TIER_REQUEST') {
      pushTier();
      return;
    }
    if (t === 'XVM_SUB_STATUS_REQUEST') {
      const result = await refreshSubscriptionStatus();
      const sub = result.ok ? subscriptionStatusFrom(result.record, Date.now()) : { tier: 'free', source: result.error || 'unavailable' };
      window.postMessage({
        type: 'XVM_SUB_STATUS',
        tier: sub.tier,
        daysLeft: 0,
        source: sub.source,
        plan: result.record?.plan || 'none',
      }, '*');
      return;
    }
    if (t === 'XVM_AUTH_TOKEN') {
      const res = await storeAuthToken(event.data.token, event.data.userId, event.data.email);
      window.postMessage({ type: 'XVM_AUTH_TOKEN_RESULT', ok: !!res.ok, error: res.error || null }, '*');
      return;
    }
    if (t === 'XVM_SIGN_OUT') {
      const res = await signOut();
      window.postMessage({ type: 'XVM_SIGN_OUT_RESULT', ok: !!res.ok }, '*');
      return;
    }
    if (t === 'XVM_CHECKOUT_START' && typeof event.data.plan === 'string') {
      const res = await startCheckout(event.data.plan);
      window.postMessage({ type: 'XVM_CHECKOUT_RESULT', ok: !!res.ok, checkoutUrl: res.checkoutUrl || null, error: res.error || null }, '*');
      return;
    }
    if (t === 'XVM_REFRESH_SUBSCRIPTION') {
      const res = await refreshSubscriptionStatus();
      window.postMessage({ type: 'XVM_REFRESH_SUBSCRIPTION_RESULT', ok: !!res.ok, error: res.error || null }, '*');
      return;
    }
    if (t === 'XVM_CONTENT_FILTER_RULES_REFRESH') {
      await fetchRemoteContentFilterRules({ force: true });
      window.postMessage({ type: 'XVM_CONTENT_FILTER_RULES_REFRESH_DONE' }, '*');
      return;
    }
  });

  // ─── Rate filter settings bridge (unchanged) ────────────────────────
  async function pushRateSettings() {
    const settings = await safeStorageGet(RATE_FILTER_KEY, null);
    if (settings && typeof settings === 'object') {
      window.postMessage({ type: 'XVM_RATE_SETTINGS_UPDATE', settings }, '*');
    }
  }

  async function pushContentFilterSettings() {
    const settings = await safeStorageGet(CONTENT_FILTER_KEY, null);
    if (settings && typeof settings === 'object') {
      window.postMessage({ type: 'XVM_CONTENT_FILTER_SETTINGS_UPDATE', settings }, '*');
    }
  }

  // ─── Remote content-filter rules (unchanged) ────────────────────────
  const RULE_TYPES_ALLOWED = new Set(['keyword', 'regex', 'domain', 'short-symbol']);
  const RULE_FIELDS_ALLOWED = new Set(['name', 'screen_name', 'bio', 'location', 'content', 'url']);
  const RULE_SEVERITIES_ALLOWED = new Set(['low', 'medium', 'high', 'block']);
  const REGEX_MAX_LEN = 400;
  const REGEX_NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)[+*?]/;

  function isValidRule(rule) {
    if (!rule || typeof rule !== 'object') return false;
    if (!RULE_TYPES_ALLOWED.has(rule.type)) return false;
    if (rule.field && !RULE_FIELDS_ALLOWED.has(rule.field)) return false;
    if (!RULE_SEVERITIES_ALLOWED.has(rule.severity)) return false;
    if (typeof rule.value !== 'string' || !rule.value.length) return false;
    if (rule.type === 'regex') {
      if (rule.value.length > REGEX_MAX_LEN) return false;
      if (REGEX_NESTED_QUANTIFIER.test(rule.value)) return false;
      try { new RegExp(rule.value, 'iu'); } catch (_) { return false; }
    }
    return true;
  }

  function isValidRulesPayload(p) {
    if (!p || typeof p !== 'object') return false;
    if (p.version !== REMOTE_RULES_CURRENT_VERSION) return false;
    if (!p.levels || typeof p.levels !== 'object') return false;
    if (!Array.isArray(p.rules)) return false;
    if (typeof p.version === 'number' && p.version > REMOTE_RULES_SCHEMA_MAX) return false;
    return p.rules.every(isValidRule);
  }

  async function pushCachedContentFilterRules() {
    const cached = await safeStorageGet(CONTENT_FILTER_RULES_KEY, null);
    if (cached && isValidRulesPayload(cached.payload)) {
      window.postMessage({
        type: 'XVM_CONTENT_FILTER_RULES_UPDATE',
        rules: cached.payload,
        source: 'remote-cache',
        fetchedAt: cached.fetchedAt || 0,
      }, '*');
      return cached;
    }
    return null;
  }

  async function fetchRemoteContentFilterRules({ force = false } = {}) {
    const cached = await safeStorageGet(CONTENT_FILTER_RULES_KEY, null);
    const cachedValid = cached && isValidRulesPayload(cached.payload);
    const now = Date.now();
    if (!force) {
      if (cachedValid && cached.fetchedAt && (now - cached.fetchedAt) < REMOTE_RULES_TTL_MS) return;
      if (cachedValid && cached.lastAttemptedAt && (now - cached.lastAttemptedAt) < REMOTE_RULES_MIN_RETRY_MS) return;
    }
    let payload = null;
    try {
      const res = await fetch(REMOTE_RULES_URL, { cache: 'no-cache' });
      if (res.ok) {
        const json = await res.json();
        if (isValidRulesPayload(json)) payload = json;
      }
    } catch (_) {}
    if (payload) {
      const record = { fetchedAt: now, lastAttemptedAt: now, payload };
      await safeStorageSet({ [CONTENT_FILTER_RULES_KEY]: record });
      window.postMessage({
        type: 'XVM_CONTENT_FILTER_RULES_UPDATE',
        rules: payload,
        source: 'remote-fresh',
        fetchedAt: record.fetchedAt,
      }, '*');
    } else if (cachedValid) {
      await safeStorageSet({ [CONTENT_FILTER_RULES_KEY]: { ...cached, lastAttemptedAt: now } });
    } else {
      await safeStorageSet({ [CONTENT_FILTER_RULES_KEY]: { lastAttemptedAt: now } });
    }
  }

  // ─── Bootstrap ──────────────────────────────────────────────────────
  (async () => {
    pushTier();
    pushRateSettings();
    pushContentFilterSettings();
    await pushCachedContentFilterRules();
    fetchRemoteContentFilterRules().catch(() => {});
  })();

  // Re-check when the authenticated session changes from another page.
  try {
    chrome?.storage?.onChanged?.addListener?.((changes, area) => {
      if (area !== 'local') return;
      if (SESSION_KEY in changes) pushTier();
      if (RATE_FILTER_KEY in changes) pushRateSettings();
      if (CONTENT_FILTER_KEY in changes) pushContentFilterSettings();
      if (CONTENT_FILTER_RULES_KEY in changes) pushCachedContentFilterRules();
    });
  } catch (_) {}
})();
