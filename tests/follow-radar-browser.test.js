import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const logicSrc = readFileSync(resolve(repo, 'src/follow-radar/logic.js'), 'utf8');
const radarSrc = readFileSync(resolve(repo, 'src/follow-radar/radar.js'), 'utf8');

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
        pillParentIsActionColumn: pill.parentElement === actionColumn,
        pillImmediatelyBeforeActionColumn: pill.nextElementSibling === actionColumn,
        noOverlap: pillBox.right <= buttonBox.left,
        pills: card.querySelectorAll('.xvm-fr-user-pill').length,
      };
    });
    expect(layout).toEqual({
      pillParentIsActionColumn: false,
      pillImmediatelyBeforeActionColumn: true,
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

    await page.waitForFunction(() => document.querySelector('.xvm-fr-user-pill')?.textContent === '我关注 0.25');
    await page.waitForTimeout(1300);
    expect(lookupRequests).toBe(1);
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

    expect(await page.locator('.xvm-fr-pill').innerText()).toContain('—');
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

    expect(await page.locator('.xvm-fr-pill').innerText()).toBe('互关 0.25');
    await page.close();
  });
});
