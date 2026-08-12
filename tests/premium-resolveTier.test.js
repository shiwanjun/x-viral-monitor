// Subscription-only tier mapping tests. The Worker owns subscription truth;
// this module only normalizes the current response.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '..', 'src/premium/license/tier-logic.js'), 'utf8');
const sandbox = { globalThis: {}, console };
sandbox.globalThis.globalThis = sandbox.globalThis;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const { subscriptionStatusFrom, tierSatisfies, VALID_TIERS } = sandbox.globalThis.__xvmTierLogic;
const NOW = 2_000_000_000_000;

function subscription(overrides = {}) {
  return { plan: 'pro', status: 'active', currentPeriodEnd: NOW + 86400000, ...overrides };
}

describe('subscription status mapping', () => {
  it('maps all active and retired Waffo products to the membership tier', () => {
    expect(subscriptionStatusFrom(subscription({ plan: 'standard' }), NOW).tier).toBe('pro');
    expect(subscriptionStatusFrom(subscription({ plan: 'pro' }), NOW).tier).toBe('pro');
    expect(subscriptionStatusFrom(subscription({ plan: 'max' }), NOW).tier).toBe('pro');
  });

  it('rejects absent, foreign, and inactive subscriptions', () => {
    expect(subscriptionStatusFrom(null, NOW).tier).toBe('free');
    expect(subscriptionStatusFrom(subscription({ plan: 'foreign' }), NOW).tier).toBe('free');
    expect(subscriptionStatusFrom(subscription({ status: 'past_due' }), NOW).tier).toBe('free');
  });

  it('keeps a canceling plan until its current period ends', () => {
    expect(subscriptionStatusFrom(subscription({ status: 'canceling' }), NOW).tier).toBe('pro');
    expect(subscriptionStatusFrom(subscription({ status: 'canceling', currentPeriodEnd: NOW - 1 }), NOW).tier).toBe('free');
  });
});

describe('subscription feature gates', () => {
  it('uses only paid tiers', () => {
    expect(VALID_TIERS).toEqual(['free', 'standard', 'pro', 'max']);
    expect(tierSatisfies('free', 'standard')).toBe(false);
    expect(tierSatisfies('standard', 'standard')).toBe(true);
    expect(tierSatisfies('pro', 'standard')).toBe(true);
    expect(tierSatisfies('pro', 'max')).toBe(false);
    expect(tierSatisfies('max', 'max')).toBe(true);
  });
});
