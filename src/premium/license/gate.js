// === Premium tier gate (M1 step 2 — MAIN world) ===
//
// Single source of truth for "what tier is the current user?" from any
// premium feature module's perspective. Feature modules MUST query this
// gate and NEVER make their own tier decisions or read subscription state.
//
// Step 2 (this version) listens for XVM_TIER_UPDATE postMessage from the
// ISOLATED-world license bridge (src/premium/license/isolated.js). The
// bridge owns chrome.storage + Worker calls; gate.js stays in MAIN world
// and only mirrors the resolved tier so feature modules don't need any
// extension context.
//
// Until the first XVM_TIER_UPDATE arrives, _currentTier defaults to 'free'
// — fail-CLOSED is safer than fail-OPEN for a paywall gate (a brief
// race-window of feature unavailability is better than a brief race-window
// of free users getting paid feature for free).
//
// API (window.__xvmPro):
//   getCurrentTier()          → 'free' | 'standard' | 'pro' | 'max'
//   isFeatureEnabled(name)    → boolean
//   onTierChange(fn)          → subscribe; fn(tier, info) on every change

(() => {
  if (window.__xvmPro) return; // idempotent on hot reload
  const isCommunityDev = window.__xvmIsCommunityDevBuild === true;

  const FEATURE_TIER = {
    'rate-filter': 'standard', // subscription feature (standard+)
    'rate-filter-advanced': 'pro', // advanced thresholds (pro+)
    'content-filter': 'free',
  };

  // Fail-closed default until isolated.js posts a real tier.
  let _currentTier = isCommunityDev ? 'pro' : 'free';
  let _daysLeft = 0;
  let _source = isCommunityDev ? 'community-dev' : 'init';
  const _subs = [];

  function getCurrentTier()  { return _currentTier; }
  function getTrialDaysLeft() { return _daysLeft; }
  function getTierSource()   { return _source; }

  function isFeatureEnabled(name) {
    if (isCommunityDev) return true;
    const need = FEATURE_TIER[name];
    if (!need || need === 'free') return true;
    const tier = getCurrentTier();
    const RANK = { free: 0, standard: 1, pro: 2, max: 3 };
    const userRank = RANK[tier] ?? 0;
    const needRank = RANK[need] ?? 99;
    return userRank >= needRank;
  }

  function onTierChange(fn) { if (typeof fn === 'function') _subs.push(fn); }

  function _setTier(next, daysLeft, source) {
    if (isCommunityDev) {
      _currentTier = 'pro';
      _daysLeft = 0;
      _source = 'community-dev';
      return;
    }
    // Internal — called when XVM_TIER_UPDATE arrives. Diff-suppressed so
    // subscribers don't see no-op churn.
    const tier = ['free','standard','pro','max'].includes(next) ? next : 'free';
    const dl = Number.isFinite(daysLeft) ? daysLeft : 0;
    const src = typeof source === 'string' ? source : 'unknown';
    const changed = tier !== _currentTier || dl !== _daysLeft;
    _currentTier = tier;
    _daysLeft = dl;
    _source = src;
    if (!changed) return;
    for (const fn of _subs) {
      try { fn(tier, { daysLeft: dl, source: src }); } catch (_) {}
    }
  }

  // Receive tier from the isolated-world bridge.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.type !== 'XVM_TIER_UPDATE') return;
    _setTier(d.tier, d.daysLeft, d.source);
  });

  // Ask the isolated-world bridge for the current tier on init. The bridge
  // may have already pushed before we mounted (race), but a duplicate push
  // is harmless (diff-suppressed above).
  window.postMessage({ type: 'XVM_TIER_REQUEST' }, '*');

  window.__xvmPro = {
    getCurrentTier,
    getTrialDaysLeft,
    getTierSource,
    isFeatureEnabled,
    onTierChange,
    _setTier, // exposed for tests + isolated.js postMessage path
    _FEATURE_TIER: FEATURE_TIER,
  };
})();
