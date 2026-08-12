// Subscription-only architecture contracts.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(repo, path), 'utf8');
const isolated = read('src/premium/license/isolated.js');
const popup = read('src/premium/license/popup-pro.js');
const tier = read('src/premium/license/tier-logic.js');
const worker = read('worker/src/index.ts');
const manifest = JSON.parse(read('manifest.json'));

describe('subscription-only access', () => {
  it('uses the Waffo/Better Auth Worker for every status lookup', () => {
    for (const source of [isolated, popup]) {
      expect(source).toMatch(/AUTH_BACKEND_URL\s*=\s*['"]https:\/\/x\.jieyiai\.dev['"]/);
      expect(source).toMatch(/\/api\/subscription\/status/);
    }
  });

  it('has no Creem, entitlement, trial, or offline-grace implementation', () => {
    for (const source of [isolated, popup, tier, worker]) {
      expect(source).not.toMatch(/creem/i);
      expect(source).not.toMatch(/entitlement/i);
      expect(source).not.toMatch(/offline-grace/i);
      expect(source).not.toMatch(/xvm_trial_v1/);
    }
    expect(existsSync(resolve(repo, 'src/premium/license/entitlement.js'))).toBe(false);
    expect(existsSync(resolve(repo, 'worker/lib/entitlement.ts'))).toBe(false);
  });

  it('keeps only the authenticated session in local storage', () => {
    expect(isolated).toMatch(/xvm_session_v1/);
    expect(isolated).not.toMatch(/lastChecked|entitlementPayload|entitlementSig/);
    expect(popup).not.toMatch(/lastChecked|entitlementPayload|entitlementSig/);
  });

  it('does not load a local entitlement verifier', () => {
    const isolatedScript = manifest.content_scripts.find((entry) => entry.js?.includes('src/premium/license/isolated.js'));
    expect(isolatedScript.js).not.toContain('src/premium/license/entitlement.js');
    expect(read('popup.html')).not.toContain('src/premium/license/entitlement.js');
  });

  it('returns only server subscription data from the worker', () => {
    expect(worker).toMatch(/\/api\/subscription\/status/);
    expect(worker).toMatch(/tier,\s*plan,\s*status,\s*expiresAt/);
    expect(worker).not.toMatch(/ENTITLEMENT_SIGNING_PRIVATE_JWK|makeSignedEntitlement/);
  });
});
