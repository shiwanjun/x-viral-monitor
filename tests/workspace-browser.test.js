import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const docs = resolve(here, '../docs');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };

describe('官网登录后数据中心浏览器回归', () => {
  let browser;
  let server;
  let origin;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/auth/get-session') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ user: { id: 'site-1', name: '夏木', email: 'summer@example.com' } }));
        return;
      }
      if (url.pathname === '/api/extension-handoff/config') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ extensionIds: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], libraryWorkspaceEnabled: true }));
        return;
      }
      if (url.pathname === '/api/subscription/status') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ tier: 'pro', plan: 'pro', status: 'active' }));
        return;
      }
      const pathname = url.pathname === '/workspace' ? '/workspace.html' : url.pathname;
      const file = normalize(join(docs, pathname));
      if (!file.startsWith(docs)) { response.writeHead(403).end(); return; }
      try {
        response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
        response.end(readFileSync(file));
      } catch (_) { response.writeHead(404).end(); }
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolveClose) => server?.close(resolveClose));
  });

  it('无扩展时仍显示官网登录信息且基础视图可交互', async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/workspace`);
    await page.waitForFunction(() => document.querySelector('#account-name')?.textContent === '夏木');
    expect(await page.locator('#account-email').textContent()).toBe('summer@example.com');
    expect(await page.locator('#auth-button b').textContent()).toBe('Pro 会员');
    expect(await page.locator('#account-tier').textContent()).toContain('PRO · 100K');
    expect(await page.locator('#connection-banner strong').textContent()).toBe('扩展未连接');
    await page.locator('#filter-toggle').click();
    expect(await page.locator('#filter-panel').isVisible()).toBe(true);
    expect(await page.locator('#empty').isVisible()).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('关系与取关导航必须留在规范数据中心路由', async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/workspace`);
    expect(await page.locator('a.nav-item').filter({ hasText: '关系' }).getAttribute('href')).toBe('/workspace?section=relations');
    expect(await page.locator('a.nav-item').filter({ hasText: '取关历史' }).getAttribute('href')).toBe('/workspace?section=unfollow');
    await page.close();
  });

  it('注入扩展数据后可完成搜索、选择和三视图切换', async () => {
    const page = await browser.newPage();
    const debug = [];
    page.on('console', (message) => debug.push(`console:${message.text()}`));
    page.on('pageerror', (error) => debug.push(`error:${error.message}`));
    await page.addInitScript(() => {
      const rows = [
        { item: { id: '1:bookmark:101', kind: 'bookmark', sourceFolderName: '灵感' }, post: { id: '101', text: '第一条带图片的书签', authorName: 'Alice', authorHandle: 'alice', createdAt: 1000, media: [{ type: 'image', url: 'https://example.com/a.jpg', previewUrl: 'https://example.com/a.jpg' }], metrics: { likes: 12, views: 300 } }, tags: [{ id: 't1', name: 'AI', color: '#654fe8' }], folders: [] },
        { item: { id: '1:like:102', kind: 'like' }, post: { id: '102', text: '第二条纯文本点赞', authorName: 'Bob', authorHandle: 'bob', createdAt: 2000, media: [], metrics: { likes: 8, views: 120 } }, tags: [], folders: [] },
      ];
      Object.defineProperty(window, 'chrome', { configurable: true, value: { runtime: {
        lastError: null,
        sendMessage(_id, message, callback) {
          if (message.type === 'XVM_LIBRARY_STATUS') callback({ ok: true, signedIn: true, isPro: true, account: { accountId: '1' }, counts: { bookmark: 1, like: 1, authored_post: 0, authored_reply: 0 }, tags: [{ id: 't1', name: 'AI', color: '#654fe8' }], folders: [], quota: { tier: 'pro', used: 2, limit: 100000, locked: 0 }, sync: { status: 'idle' } });
          else if (message.type === 'XVM_LIBRARY_QUERY') callback({ ok: true, rows: message.query.search ? rows.filter((row) => row.post.text.includes(message.query.search)) : rows, cursor: null, quota: { tier: 'pro', used: 2, limit: 100000, locked: 0 } });
          else callback({ ok: true });
        },
      } } });
      window.__auditChrome = Boolean(window.chrome?.runtime?.sendMessage);
    });
    await page.goto(`${origin}/workspace`);
    try { await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 2, null, { timeout: 3000 }); }
    catch (error) { throw new Error(`${error.message}\n${debug.join('\n')}\nchrome=${await page.evaluate(() => window.__auditChrome)} runtime=${await page.evaluate(() => typeof window.chrome?.runtime?.sendMessage)}\n${await page.locator('#connection-banner').innerText()}`); }
    await page.locator('[data-view="gallery"]').click();
    expect(await page.locator('#view-gallery').isVisible()).toBe(true);
    expect(await page.locator('#view-gallery .gallery-card').count()).toBe(2);
    await page.locator('[data-view="stats"]').click();
    expect(await page.locator('#view-stats').isVisible()).toBe(true);
    await page.locator('[data-view="table"]').click();
    await page.locator('#rows .row-check').first().check();
    expect(await page.locator('#batch-bar').isVisible()).toBe(true);
    expect(await page.locator('#selected-count').textContent()).toBe('1');
    await page.locator('#search').fill('第二条');
    await page.waitForTimeout(350);
    expect(await page.locator('#rows tr').count()).toBe(1);
    expect(await page.locator('#rows').innerText()).toContain('第二条纯文本点赞');
    await page.close();
  });
});
