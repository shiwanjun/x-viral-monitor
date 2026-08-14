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
    await page.locator('[data-section="relations"]').click();
    expect(new URL(page.url()).searchParams.get('section')).toBe('relations');
    expect(await page.locator('#relations-screen').isVisible()).toBe(true);
    await page.locator('[data-section="unfollow"]').click();
    expect(new URL(page.url()).searchParams.get('section')).toBe('unfollow');
    expect(await page.locator('#unfollow-screen').isVisible()).toBe(true);
    await page.close();
  });

  it('注入扩展数据后可完成搜索、选择和三视图切换', async () => {
    const page = await browser.newPage();
    const debug = [];
    page.on('console', (message) => debug.push(`console:${message.text()}`));
    page.on('pageerror', (error) => debug.push(`error:${error.message}`));
    await page.addInitScript(() => {
      const rows = [
        { item: { id: '1:bookmark:101', kind: 'bookmark', sourceFolderName: '灵感' }, post: { id: '101', text: '第一条带图片的书签\n第二行仍需完整展示', authorName: 'Alice', authorHandle: 'alice', authorAvatar: '/x-tools-logo.png', createdAt: Date.UTC(2026, 7, 13, 10, 23), media: [{ type: 'video', url: 'https://example.com/a.mp4', previewUrl: '/x-tools-logo.png' }], metrics: { likes: 12, views: 300, reposts: 7, replies: 3, bookmarks: 2 } }, tags: [{ id: 't1', name: 'AI', color: '#654fe8' }], folders: [] },
        { item: { id: '1:like:102', kind: 'like' }, post: { id: '102', text: '第二条纯文本点赞', authorName: 'Bob', authorHandle: 'bob', createdAt: Date.UTC(2026, 7, 12, 9, 8), media: [], metrics: { likes: 8, views: 120, reposts: 2, replies: 1, bookmarks: 0 } }, tags: [], folders: [] },
      ];
      Object.defineProperty(window, 'chrome', { configurable: true, value: { runtime: {
        lastError: null,
        sendMessage(_id, message, callback) {
          (window.__libraryMessages ||= []).push(JSON.parse(JSON.stringify(message)));
          if (message.type === 'XVM_LIBRARY_STATUS') callback({ ok: true, signedIn: true, isPro: true, account: { accountId: '1' }, counts: { bookmark: 1, like: 1, authored_post: 0, authored_reply: 0 }, tags: [{ id: 't1', name: 'AI', color: '#654fe8' }], folders: [], quota: { tier: 'pro', used: 2, limit: 100000, locked: 0 }, sync: { status: 'idle' } });
          else if (message.type === 'XVM_LIBRARY_QUERY') callback({ ok: true, rows: rows.filter((row) => (!message.query.search || row.post.text.includes(message.query.search)) && (!message.query.kind || message.query.kind === 'all' || row.item.kind === message.query.kind)), cursor: null, quota: { tier: 'pro', used: 2, limit: 100000, locked: 0 } });
          else if (message.type === 'XVM_LIBRARY_MUTATE' && message.payload.action === 'list_filters') callback({ ok: true, items: [{ id: 'sf1', name: 'AI 灵感', query: { kind: 'bookmark', search: '第一条' } }] });
          else if (message.type === 'XVM_LIBRARY_RELATIONSHIPS') callback({ ok: true, users: [{ handle: 'alice', n: 'Alice', f: 1, b: 1, fc: 100, fd: 80 }], events: [{ id: 'unfollowed_me:bob:1000', h: 'bob', n: 'Bob', type: 'unfollowed_me', ts: 1000, fc: 200, fd: 40 }], counts: { mutual: 1, mine: 0, theirs: 0, unfollowed: 1 }, cloudSync: true });
          else callback({ ok: true });
        },
      } } });
      window.__openedUrls = [];
      window.open = (url) => { window.__openedUrls.push(String(url)); return null; };
      window.__auditChrome = Boolean(window.chrome?.runtime?.sendMessage);
    });
    await page.goto(`${origin}/workspace`);
    try { await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 2, null, { timeout: 3000 }); }
    catch (error) { throw new Error(`${error.message}\n${debug.join('\n')}\nchrome=${await page.evaluate(() => window.__auditChrome)} runtime=${await page.evaluate(() => typeof window.chrome?.runtime?.sendMessage)}\n${await page.locator('#connection-banner').innerText()}`); }
    const tableHead = await page.locator('#library-data-table thead').innerText();
    expect(tableHead).toContain('用户');
    expect(tableHead).toContain('文件夹 / 标签');
    expect(tableHead).toContain('推文');
    expect(tableHead).toContain('媒体文件');
    expect(tableHead).toContain('浏览量');
    expect(tableHead).toContain('转发数');
    expect(tableHead).toContain('点赞数');
    expect(tableHead).toContain('回复数');
    expect(tableHead).toContain('创建时间');
    const firstRow = page.locator('#rows tr').first();
    expect(await firstRow.locator('.table-user strong').textContent()).toBe('Alice');
    expect(await firstRow.locator('.tweet-full-text').textContent()).toBe('第一条带图片的书签\n第二行仍需完整展示');
    expect(await firstRow.locator('[data-metric="views"]').textContent()).toBe('300');
    expect(await firstRow.locator('[data-metric="reposts"]').textContent()).toBe('7');
    expect(await firstRow.locator('[data-metric="likes"]').textContent()).toBe('12');
    expect(await firstRow.locator('[data-metric="replies"]').textContent()).toBe('3');
    expect(await firstRow.locator('.created-at').textContent()).toMatch(/^2026-08-13 \d{2}:23$/);
    expect(await firstRow.locator('.media-tile').count()).toBe(1);
    expect(await firstRow.locator('.media-play').count()).toBe(1);
    await page.locator('[data-view="gallery"]').click();
    expect(await page.locator('#view-gallery').isVisible()).toBe(true);
    expect(await page.locator('#view-gallery .gallery-card').count()).toBe(2);
    await page.locator('#view-gallery .gallery-card').first().click();
    expect(await page.evaluate(() => window.__openedUrls.at(-1))).toBe('https://x.com/alice/status/101');
    await page.locator('[data-view="stats"]').click();
    expect(await page.locator('#view-stats').isVisible()).toBe(true);
    await page.locator('[data-view="table"]').click();
    await page.locator('[data-kind="like"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 1);
    expect(await page.locator('#page-title').textContent()).toBe('点赞');
    expect(await page.locator('#rows').innerText()).toContain('第二条纯文本点赞');
    await page.locator('[data-kind="all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#rows tr').length === 2);
    await page.locator('[data-sync-kind="bookmark"]').click();
    await page.waitForFunction(() => window.__libraryMessages.some((message) => message.type === 'XVM_LIBRARY_SYNC_START' && message.payload.operations.includes('Bookmarks')));
    await page.locator('#rows .row-check').first().check();
    expect(await page.locator('#batch-bar').isVisible()).toBe(true);
    expect(await page.locator('#selected-count').textContent()).toBe('1');
    await page.locator('#search').fill('第二条');
    await page.waitForTimeout(350);
    expect(await page.locator('#rows tr').count()).toBe(1);
    expect(await page.locator('#rows').innerText()).toContain('第二条纯文本点赞');
    await page.locator('#filter-toggle').click({ timeout: 2000 });
    await page.locator('[data-apply-filter="sf1"]').click({ timeout: 2000 });
    const filterDebug = await page.evaluate(() => ({ search: document.querySelector('#search')?.value, html: document.querySelector('#saved-filters')?.innerHTML, messages: window.__libraryMessages }));
    expect(filterDebug.search, JSON.stringify(filterDebug)).toBe('第一条');
    await page.waitForTimeout(500);
    expect(await page.locator('#rows').innerText(), JSON.stringify(filterDebug)).toContain('第一条带图片的书签');
    await page.locator('[data-section="relations"]').click();
    expect(await page.locator('#relation-list').innerText()).toContain('互关');
    expect(await page.locator('#relation-list').innerText()).toContain('0.80');
    await page.locator('#relation-list .relation-row').click();
    expect(await page.evaluate(() => window.__openedUrls.at(-1))).toBe('https://x.com/alice');
    await page.locator('[data-section="unfollow"]').click();
    expect(await page.locator('#unfollow-list').innerText()).toContain('TA 取关我');
    await page.close();
  }, 15_000);
});
