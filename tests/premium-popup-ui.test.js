import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(repo, 'popup.html'), 'utf8');
const popup = readFileSync(resolve(repo, 'src/premium/license/popup-pro.js'), 'utf8');

describe('subscription hub popup', () => {
  it('mounts the subscription surface without a license key form', () => {
    expect(html).toMatch(/id="xvm-pro-section"/);
    expect(html).toMatch(/src="src\/premium\/license\/popup-pro\.js"/);
    expect(html).not.toMatch(/activate-inline|activate-key|entitlement\.js/);
  });

  it('uses the official Better Auth login flow, Waffo checkout, and subscription management', () => {
    expect(popup).toMatch(/extensionLogin/);
    expect(popup).toMatch(/PRODUCT_SITE_URL/);
    expect(popup).not.toMatch(/auth-callback\.html/);
    expect(popup).toMatch(/\/api\/checkout\/start/);
    expect(popup).toMatch(/\/api\/subscription\/status/);
    expect(popup).toMatch(/WAFFO_PORTAL_URL/);
  });

  it('reads current status from the Worker instead of local entitlement state', () => {
    expect(popup).toMatch(/async function refreshSubscriptionStatus/);
    expect(popup).toMatch(/await refreshSubscriptionStatus\(\)/);
    expect(popup).not.toMatch(/entitlement|xvm_trial_v1|offline-grace/i);
  });

  it('does not contain Creem payment or license activation code', () => {
    expect(popup).not.toMatch(/creem|LICENSE_PROXY_URL|maskKey|KEY_RE/i);
  });
});
