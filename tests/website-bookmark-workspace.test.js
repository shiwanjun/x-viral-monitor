import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const background = readFileSync(resolve(root, 'background.js'), 'utf8');
const workspace = readFileSync(resolve(root, 'docs/workspace.html'), 'utf8');
const script = readFileSync(resolve(root, 'docs/workspace.js'), 'utf8');

describe('官网统一数据中心', () => {
  it('只允许受信官网通过分页契约读取扩展 IndexedDB', () => {
    expect(background).toContain("message?.type?.startsWith('XVM_LIBRARY_')");
    expect(background).toContain('isOfficialWebsiteSender(sender)');
    expect(background).toContain('XvmLibraryDb.query');
    expect(background).toContain('Math.min(50');
  });

  it('官网支持搜索、组合筛选、三视图与游标分页', () => {
    expect(script).toContain("type: 'XVM_LIBRARY_QUERY'");
    expect(script).toContain('queryPayload()');
    expect(workspace).toContain('data-view="gallery"');
    expect(workspace).toContain('data-view="stats"');
    expect(script).toContain("$('#next').onclick");
  });

  it('页面明确披露本地与云端隐私边界', () => {
    expect(workspace).toContain('不上传 Cookie 或媒体文件');
    expect(script).toContain('不会上传 X Cookie、Bearer、原始 GraphQL 响应、AI Key 或媒体文件');
  });

  it('增量同步由扩展后台执行且无需保持 X 页面打开', () => {
    expect(background).toContain('runBackgroundLibrarySync');
    expect(background).toContain('LIBRARY_AUTH_KEY');
    expect(script).toContain('同步已开始，可关闭 X 页面');
  });
});
