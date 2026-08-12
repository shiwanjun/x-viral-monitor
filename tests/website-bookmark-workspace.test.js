import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const background = readFileSync(resolve(root, 'background.js'), 'utf8');
const workspace = readFileSync(resolve(root, 'docs/workspace.html'), 'utf8');

describe('官网书签工作台', () => {
  it('只允许受信官网请求扩展内的书签投影数据', () => {
    expect(background).toContain("message?.type === 'XVM_WEBSITE_DASHBOARD_SNAPSHOT'");
    expect(background).toContain('isOfficialWebsiteSender(sender)');
    expect(background).toContain("chrome.storage.local.get(['bookmarkTimelineCache', 'bookmarkFoldersCache']");
    expect(background).toContain('makeWebsiteDashboardSnapshot');
  });

  it('官网用外部消息读取数据，并提供搜索、筛选与分页交互', () => {
    expect(workspace).toContain("type:'XVM_WEBSITE_DASHBOARD_SNAPSHOT'");
    expect(workspace).toContain('function activeRows()');
    expect(workspace).toContain("data-media-filter=\"media\"");
    expect(workspace).toContain('data-page="next"');
    expect(workspace).toContain('从扩展刷新');
  });

  it('页面明确标示书签不会经服务器上传', () => {
    expect(workspace).toContain('不会上传到 X-Tools 服务器');
  });
});
