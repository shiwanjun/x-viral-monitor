import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const debugScript = readFileSync(resolve(repo, 'userscript/x-viral-monitor.debug.user.js'), 'utf8');
const releaseScript = readFileSync(resolve(repo, 'userscript/x-viral-monitor.user.js'), 'utf8');

describe('iOS userscript debug build', () => {
  it('is a separate DEBUG userscript and does not replace the release script', () => {
    expect(debugScript).toContain('@name         X-Tools Minimal Badge DEBUG');
    expect(debugScript).toContain('@version      1.0.0');
    expect(debugScript).toContain('Debug build for iOS Userscripts');
    expect(releaseScript).toContain('@name         X-Tools Minimal Badge');
    expect(releaseScript).not.toContain('@name         X-Tools Minimal Badge DEBUG');
  });

  it('ships an on-page mobile diagnostics overlay with Eruda loader', () => {
    expect(debugScript).toContain('https://cdn.jsdelivr.net/npm/eruda@3/eruda.min.js');
    expect(debugScript).toContain('function installDebugOverlay()');
    expect(debugScript).toContain('function collectDebugMetrics()');
    expect(debugScript).toContain('id = \'xvm-debug-panel\'');
    expect(debugScript).toContain('[data-xvm-debug-eruda]');
    expect(debugScript).toContain('[data-xvm-debug-copy]');
    expect(debugScript).toContain('xvm-debug-launcher');
    expect(debugScript).toContain('xvm-debug-backdrop');
    expect(debugScript).toContain('Copy Bundle');
  });

  it('exposes the metrics needed to diagnose iOS badge failures', () => {
    for (const token of [
      'hookInstalled',
      'capturedGraphql',
      'extractedTweets',
      'leaderboardItems',
      'badgeMountAttempts',
      'badgeMounts',
      'badges',
      'articles',
      'lastBadgeReason',
      'lastIgnoredReason',
      'graphqlResourceUrls',
      'pageHookMode',
      'domFallbackTweets',
      'graphqlDebugBuffer',
      'refetchAttempts',
      'refetchSuccesses',
      'refetchFailures',
    ]) {
      expect(debugScript).toContain(token);
    }
  });

  it('logs the critical hook, GraphQL, DOM, and badge paths', () => {
    for (const phrase of [
      'debug userscript boot',
      'fetch hook installed',
      'XHR hook installed',
      'GraphQL response captured by hook',
      'GraphQL message accepted',
      'DOM observers installed',
      'badge mounted',
      'page-world script hook injected',
      'PerformanceObserver resource fallback installed',
      'DOM visible metrics fallback extracted',
      'GraphQL resource refetched',
      'GraphQL request captured',
      'Full debug bundle copied',
    ]) {
      expect(debugScript).toContain(phrase);
    }
  });

  it('includes iOS fallback paths for sandboxed Userscripts', () => {
    expect(debugScript).toContain('function injectPageWorldScriptHook()');
    expect(debugScript).toContain('XVM_TM_PAGE_HOOK_STATUS');
    expect(debugScript).toContain('source, payload, capturedAt');
    expect(debugScript).toContain('function installResourceObserver()');
    expect(debugScript).toContain('performance.getEntriesByType');
    expect(debugScript).toContain('function refetchGraphqlUrl(url, source = \'resource-refetch\')');
    expect(debugScript).toContain('credentials: \'include\'');
    expect(debugScript).toContain('function getCookieValue(name)');
    expect(debugScript).toContain('headers[\'x-csrf-token\'] = csrf');
    expect(debugScript).toContain('x-twitter-active-user');
    expect(debugScript).toContain('x-twitter-auth-type');
    expect(debugScript).toContain('function buildDebugBundle()');
    expect(debugScript).toContain('function recordGraphqlDebug(entry)');
    expect(debugScript).toContain('XVM_TM_GRAPHQL_REQUEST');
    expect(debugScript).toContain('function extractVisibleTweetData(article, id)');
    expect(debugScript).toContain('function getCreatedAtFromArticle(article)');
    expect(debugScript).toContain('const minHours = data.estimatedCreatedAt ? 1 : 5 / 60');
    expect(debugScript).toContain('time[datetime]');
    expect(debugScript).not.toContain('createdAt: new Date().toUTCString()');
    expect(debugScript).toContain('source: \'dom-visible-fallback\'');
  });

  it('disables the mobile debug leaderboard while keeping badges and debug launcher', () => {
    expect(debugScript).toContain('const ENABLE_DEBUG_LEADERBOARD = false');
    expect(debugScript).toContain('if (!ENABLE_DEBUG_LEADERBOARD || !settings.leaderboardEnabled)');
    expect(debugScript).toContain('leaderboardEnabled: false');
    expect(debugScript).toContain('xvm-debug-launcher');
  });
});
