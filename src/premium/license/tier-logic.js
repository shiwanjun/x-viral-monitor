// === Subscription tier helpers (CommonJS + globalThis dual-mode) ===
//
// Subscription state is authoritative on the Worker. This module only maps
// the response returned by /api/subscription/status into a feature tier; it
// deliberately has no trial, local signed state, cache, or grace-period logic.

(function (root) {
  'use strict';

  // Waffo plan → tier mapping. Mirrors the Worker's PLAN_TO_TIER.
  const PLAN_TO_TIER = {
    // Retired products are treated as the single membership during the
    // migration, so no existing subscriber loses access.
    standard: 'pro',
    pro: 'pro',
    max: 'pro',
    none: 'free',
  };

  const VALID_TIERS = ['free', 'standard', 'pro', 'max'];
  const VALID_PLANS = Object.keys(PLAN_TO_TIER);

  function isXvmPlan(plan) {
    return typeof plan === 'string' && plan in PLAN_TO_TIER;
  }

  function tierForPlan(plan) {
    return PLAN_TO_TIER[plan] || 'free';
  }

  // Normalize one server response. A canceling subscription remains active
  // until the Worker says its current period has ended.
  function subscriptionStatusFrom(record, now) {
    const t = now == null ? Date.now() : now;
    if (!record || !isXvmPlan(record.plan)) return { tier: 'free', source: 'none' };
    if (record.status !== 'active' && record.status !== 'canceling') return { tier: 'free', source: 'inactive' };
    if (record.status === 'canceling' && record.currentPeriodEnd && t > record.currentPeriodEnd) {
      return { tier: 'free', source: 'ended' };
    }
    return { tier: tierForPlan(record.plan), source: 'subscription' };
  }

  // ─── Feature gating helpers ─────────────────────────────────────────
  // A feature requires a MINIMUM tier. These helpers implement the ordering
  const TIER_RANK = { free: 0, standard: 1, pro: 2, max: 3 };

  function tierSatisfies(userTier, requiredTier) {
    const user = TIER_RANK[userTier];
    const req = TIER_RANK[requiredTier];
    if (user == null || req == null) return false;
    return user >= req;
  }

  const api = {
    PLAN_TO_TIER, VALID_TIERS, VALID_PLANS,
    isXvmPlan, tierForPlan, tierSatisfies,
    subscriptionStatusFrom,
    TIER_RANK,
  };

  if (root) root.__xvmTierLogic = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
