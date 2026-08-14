import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const logicSrc = readFileSync(resolve(repo, 'src/follow-radar/logic.js'), 'utf8');
const radarSrc = readFileSync(resolve(repo, 'src/follow-radar/radar.js'), 'utf8');
const stylesSrc = readFileSync(resolve(repo, 'styles.css'), 'utf8');

describe('关注雷达浏览器回归', () => {
  let browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('用户卡片经过多轮观察和状态刷新后仍只有一个胶囊', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div data-testid="UserCell">
        <a role="link" href="/EBBO2025"><span>EBBO</span></a>
        <div><button>正在关注</button></div>
      </div>
    `);
    await page.addScriptTag({ content: logicSrc });
    await page.addScriptTag({ content: radarSrc });

    await page.waitForTimeout(2200);

    const result = await page.locator('[data-testid="UserCell"]').evaluate((card) => ({
      pills: card.querySelectorAll('.xvm-fr-pill').length,
      userPills: card.querySelectorAll('.xvm-fr-user-pill').length,
      classes: [...card.querySelectorAll('.xvm-fr-pill')].map((node) => node.className),
    }));
    expect(result).toMatchObject({ pills: 1, userPills: 1 });
    await page.close();
  });

  it('用户列表胶囊位于操作按钮列左侧且不会与原按钮重叠', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.setContent(`
      <style>
        [data-testid="UserCell"] { width: 620px; display:flex; align-items:center; gap:12px; }
        .profile-content { flex:1; min-width:0; }
        .competitor-pill { display:inline-flex; width:90px; height:28px; }
        .action-column { flex:none; width:92px; }
        .action-column button { width:92px; height:34px; }
        .xvm-fr-pill { display:inline-flex; flex:none; min-width:96px; height:28px; }
      </style>
      <div data-testid="UserCell">
        <div class="profile-content">
          <a role="link" href="/alice"><span>Alice</span></a>
          <span class="competitor-pill">我关注 0.24</span>
        </div>
        <div class="action-column"><button>正在关注</button></div>
      </div>
    `);
    await page.addScriptTag({ content: logicSrc });
    await page.addScriptTag({ content: radarSrc });
    await page.waitForTimeout(1500);

    const layout = await page.locator('[data-testid="UserCell"]').evaluate((card) => {
      const pill = card.querySelector('.xvm-fr-user-pill');
      const actionColumn = card.querySelector('.action-column');
      const button = card.querySelector('button');
      const pillBox = pill.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      return {
        pillParentIsCard: pill.parentElement === card,
        verticallyAligned: Math.abs((pillBox.top + pillBox.height / 2) - (buttonBox.top + buttonBox.height / 2)) < 1,
        noOverlap: pillBox.right <= buttonBox.left || pillBox.left >= buttonBox.right,
        pills: card.querySelectorAll('.xvm-fr-user-pill').length,
      };
    });
    expect(layout).toEqual({
      pillParentIsCard: true,
      verticallyAligned: true,
      noOverlap: true,
      pills: 1,
    });
    await page.close();
  });

  it('用户批量资料接口返回后会显示关注数除以粉丝数且只请求一次', async () => {
    const page = await browser.newPage();
    let lookupRequests = 0;
    await page.route('https://x.com/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/i/api/1.1/users/lookup.json') {
        lookupRequests++;
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify([{
            id_str: '1', screen_name: 'alice', name: 'Alice',
            followers_count: 200, friends_count: 50,
            following: true, followed_by: false,
          }]),
        });
        return;
      }
      await route.fulfill({
        contentType: 'text/html',
        body: '<div data-testid="UserCell"><a role="link" href="/alice"><span>Alice</span></a><div><button>正在关注</button></div></div>',
      });
    });
    await page.goto('https://x.com/test');
    await page.addScriptTag({ content: logicSrc });
    await page.addScriptTag({ content: radarSrc });

    await page.waitForFunction(() => document.querySelector('.xvm-fr-user-pill .xvm-fr-pill-label')?.textContent === '我关注了 0.25');
    await page.waitForTimeout(1300);
    expect(lookupRequests).toBe(1);
    await page.close();
  });

  it('可复用同一用户行已有的数值率且不会继续显示破折号', async () => {
    const page = await browser.newPage();
    await page.setContent('<div data-testid="UserCell"><a role="link" href="/alice">Alice</a><span class="other-extension">互关 0.53</span><button>正在关注</button></div>');
    await page.addScriptTag({ content: logicSrc });
    await page.addScriptTag({ content: radarSrc });
    await page.waitForFunction(() => document.querySelector('.xvm-fr-user-pill .xvm-fr-pill-label')?.textContent === '我关注了 0.53');
    expect(await page.locator('.xvm-fr-user-pill').count()).toBe(1);
    await page.close();
  });

  it('资料计数返回后会把时间线的破折号更新为真实关注率', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <article data-testid="tweet">
        <div style="display:flex;flex-direction:row">
          <div data-testid="User-Name"><a role="link" href="/alice"><span>Alice</span><span>@alice</span></a></div>
          <button data-testid="caret" aria-label="更多">...</button>
        </div>
      </article>
    `);
    await page.addScriptTag({ content: logicSrc });
    await page.addScriptTag({ content: radarSrc });
    await page.waitForTimeout(800);

    expect(await page.locator('.xvm-fr-pill-label').innerText()).toContain('—');
    await page.evaluate(() => {
      window.__xvmFollowRadar.ingestProfileRow({
        data: { user: { result: {
          rest_id: '1',
          core: { screen_name: 'alice', name: 'Alice' },
          legacy: { followers_count: 200, friends_count: 50, following: true, followed_by: true },
        } } },
      }, 'alice');
    });
    await page.waitForTimeout(800);

    expect(await page.locator('.xvm-fr-pill-label').innerText()).toBe('互关 0.25');
    await page.close();
  });

  it('关系接口缺少计数时不会误判完成，并会继续查询资料计数', async () => {
    const page = await browser.newPage();
    let lookupRequests = 0;
    let showRequests = 0;
    await page.route('https://x.com/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/i/api/1.1/users/lookup.json') {
        lookupRequests++;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ screen_name: 'alice', following: false, followed_by: true }]) });
        return;
      }
      if (url.pathname === '/i/api/1.1/users/show.json') {
        showRequests++;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ screen_name: 'alice', followers_count: 200, friends_count: 50, following: false, followed_by: true }) });
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: '<article data-testid="tweet"><div style="display:flex"><div data-testid="User-Name"><a role="link" href="/alice"><span>Alice</span><span>@alice</span></a></div><button data-testid="caret">...</button></div></article>' });
    });
    await page.goto('https://x.com/test');
    await page.addScriptTag({ content: logicSrc });
    await page.addScriptTag({ content: radarSrc });
    await page.waitForFunction(() => document.querySelector('.xvm-fr-pill-label')?.textContent === '关注我 0.25');
    expect(lookupRequests).toBe(1);
    expect(showRequests).toBe(1);
    await page.close();
  });

  it('REST 资料接口不可用时使用当前 UserByScreenName 模板补齐关注率', async () => {
    const page = await browser.newPage();
    let graphRequests = 0;
    await page.route('https://x.com/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.includes('/i/api/1.1/users/')) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        return;
      }
      if (url.pathname === '/i/api/graphql/IGgvgiOx4QZndDHuD3x9TQ/UserByScreenName') {
        graphRequests++;
        expect(url.searchParams.get('fieldToggles')).toContain('withAuxiliaryUserLabels');
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { user: { result: {
          rest_id: '1', core: { screen_name: 'alice', name: 'Alice' },
          legacy: { followers_count: 400, friends_count: 100, following: false, followed_by: false },
        } } } }) });
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: '<article data-testid="tweet"><div style="display:flex"><div data-testid="User-Name"><a role="link" href="/alice"><span>Alice</span><span>@alice</span></a></div><button data-testid="caret">...</button></div></article>' });
    });
    await page.goto('https://x.com/test');
    await page.addScriptTag({ content: logicSrc });
    await page.addScriptTag({ content: radarSrc });
    await page.waitForFunction(() => document.querySelector('.xvm-fr-pill-label')?.textContent === '关注率 0.25');
    expect(graphRequests).toBe(1);
    await page.close();
  });

  it('帖子详情回复批量查询限频后会自动重试且不会逐条请求形成风暴', async () => {
    const page = await browser.newPage();
    let lookupRequests = 0;
    let showRequests = 0;
    let graphRequests = 0;
    await page.route('https://x.com/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/i/api/1.1/users/lookup.json') {
        lookupRequests++;
        if (lookupRequests === 1) {
          await route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"rate_limited"}' });
        } else {
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify([
            { screen_name: 'alice', followers_count: 200, friends_count: 50, following: true, followed_by: true },
            { screen_name: 'bob', followers_count: 100, friends_count: 40, following: false, followed_by: false },
          ]) });
        }
        return;
      }
      if (url.pathname === '/i/api/1.1/users/show.json') {
        showRequests++;
        await route.fulfill({ status: 429, contentType: 'application/json', body: '{}' });
        return;
      }
      if (url.pathname.endsWith('/UserByScreenName')) {
        graphRequests++;
        await route.fulfill({ status: 429, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: `
        <main aria-label="主页时间线"><section aria-label="对话">
          <article data-testid="tweet"><div style="display:flex"><div data-testid="User-Name"><a role="link" href="/alice"><span>Alice</span><span>@alice</span></a></div><button data-testid="caret">...</button></div></article>
          <article data-testid="tweet"><div style="display:flex"><div data-testid="User-Name"><a role="link" href="/bob"><span>Bob</span><span>@bob</span></a></div><button data-testid="caret">...</button></div></article>
        </section></main>` });
    });
    await page.goto('https://x.com/alice/status/123');
    await page.addScriptTag({ content: logicSrc });
    await page.addScriptTag({ content: radarSrc.replace(
      'const PROFILE_LOOKUP_RETRY_MS = 15_000;',
      'const PROFILE_LOOKUP_RETRY_MS = 120;',
    ) });

    await page.waitForFunction(() => {
      const labels = [...document.querySelectorAll('.xvm-fr-pill-label')].map((node) => node.textContent);
      return labels.includes('互关 0.25') && labels.includes('关注率 0.4');
    }, null, { timeout: 4000 });
    expect(lookupRequests).toBe(2);
    expect(showRequests).toBe(0);
    expect(graphRequests).toBe(0);
    await page.close();
  });

  it('时间线胶囊固定在三点菜单之后且悬浮显示账号详情', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await page.setContent(`
      <article data-testid="tweet">
        <div class="header" style="display:flex;align-items:center;width:620px">
          <div data-testid="User-Name" style="flex:1"><a role="link" href="/alice"><span>Alice</span><span>@alice</span></a></div>
          <button data-testid="caret" aria-label="更多">...</button>
        </div>
      </article>`);
    await page.addScriptTag({ content: logicSrc });
    await page.addScriptTag({ content: radarSrc });
    await page.addStyleTag({ content: stylesSrc });
    await page.waitForTimeout(800);
    await page.evaluate(() => window.__xvmFollowRadar.ingestProfileRow({ screen_name: 'alice', followers_count: 200, friends_count: 50, followed_by: true }, 'alice'));
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      for (let index = 0; index < 5; index += 1) window.__xvmFollowRadar.applyToTimeline();
    });
    const layout = await page.locator('article').evaluate((article) => {
      const pill = article.querySelector('.xvm-fr-pill'); const caret = article.querySelector('[data-testid="caret"]');
      return {
        afterCaret: caret.nextElementSibling === pill,
        pillRight: pill.getBoundingClientRect().right,
        caretRight: caret.getBoundingClientRect().right,
        pillCount: article.querySelectorAll('.xvm-fr-pill').length,
      };
    });
    expect(layout.afterCaret).toBe(true);
    expect(layout.pillRight).toBeGreaterThan(layout.caretRight);
    expect(layout.pillCount).toBe(1);
    await page.locator('.xvm-fr-pill').hover();
    await page.locator('.xvm-fr-tooltip').waitFor({ state: 'visible' });
    const tooltip = await page.locator('.xvm-fr-tooltip').innerText();
    expect(await page.locator('.xvm-fr-brand').innerText()).toBe('XT');
    expect(tooltip).toContain('X-Tools 关系详情');
    expect(tooltip).toContain('关系：关注我');
    expect(tooltip).toContain('粉丝：200');
    expect(tooltip).toContain('关注人数：50');
    expect(tooltip).toContain('对当前用户取关过：否');
    await page.close();
  });
});
