import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const worker = read('worker/src/index.ts');
const background = read('background.js');
const popup = read('src/premium/license/popup-pro.js');
const site = read('docs/index.html');
const manifest = JSON.parse(read('manifest.json'));

describe('website-to-extension auth handoff', () => {
  it('stores only hashed, single-use, expiring handoff codes', () => {
    expect(read('worker/auth/schema.sql')).toMatch(/CREATE TABLE IF NOT EXISTS "extension_handoffs"/);
    expect(worker).toMatch(/crypto\.subtle\.digest\("SHA-256"/);
    expect(worker).toMatch(/HANDOFF_TTL_MS = 60_000/);
    expect(worker).toMatch(/consumed_at IS NULL AND expires_at > \?/);
    expect(worker).toMatch(/consumed\.meta\?\.changes/);
  });

  it('binds handoffs to an allowed extension and returns a bearer token only to its exchange endpoint', () => {
    expect(worker).toMatch(/allowedExtensionIds/);
    expect(worker).toMatch(/extension_not_allowed/);
    expect(worker).toMatch(/\/api\/extension-handoff\/create/);
    expect(worker).toMatch(/\/api\/extension-handoff\/exchange/);
    expect(worker).toMatch(/\/api\/extension-handoff\/config/);
    expect(worker).toMatch(/serializeSignedCookie/);
    expect(read('worker/wrangler.auth.toml')).toMatch(/lfhpokjhhnpphhdadnaclbailchgkfnn/);
  });

  it('permits incoming extension messages only from the official website', () => {
    expect(manifest.externally_connectable.matches).toEqual(['https://x.jieyiai.dev/*']);
    expect(background).toMatch(/onMessageExternal/);
    expect(background).toMatch(/isOfficialWebsiteSender/);
    expect(background).toMatch(/XVM_WEBSITE_AUTH_HANDOFF/);
    expect(background).toMatch(/XVM_WEBSITE_AUTH_PROBE/);
  });

  it('starts Google login on the official website instead of a callback page in the extension', () => {
    expect(popup).toMatch(/extensionLogin/);
    expect(popup).toMatch(/window\.open\(loginUrl\.toString\(\), '_blank', 'noopener'\)/);
    expect(popup).not.toMatch(/auth-callback\.html/);
    expect(background).not.toMatch(/XVM_AUTH_TOKEN/);
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it('automatically hands a website session to an installed extension', () => {
    expect(site).toMatch(/syncWebsiteLoginToExtension/);
    expect(site).toMatch(/XVM_WEBSITE_AUTH_HANDOFF/);
    expect(site).toMatch(/extension-handoff\/create/);
    expect(site).toMatch(/if \(siteSession\?\.user\)/);
    expect(site).toMatch(/void syncWebsiteLoginToExtension\(\)/);
    expect(site).toMatch(/extensionLoginRequested/);
    expect(site).toMatch(/location\.assign\('\/workspace'\)/);
  });

  it('官网在支付尚未配置时给出明确提示', () => {
    expect(site).toMatch(/payments_not_configured/);
    expect(site).toMatch(/支付暂未配置完成/);
  });
});
