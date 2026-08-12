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
