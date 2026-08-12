import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = readFileSync(resolve(root, 'dashboard.js'), 'utf8');
const worker = readFileSync(resolve(root, 'worker/src/index.ts'), 'utf8');
const schema = readFileSync(resolve(root, 'worker/auth/schema.sql'), 'utf8');

describe('工作台会员与取关同步链路', () => {
  it('使用与插件相同的本地会话和订阅缓存', () => {
    expect(dashboard).toContain('xvm_session_v1');
    expect(dashboard).toContain('xvm_subscription_v1');
    expect(dashboard).toContain("/api/subscription/status");
  });

  it('会员通过 Bearer 会话同步取关历史，且本地预览不会写入生产接口', () => {
    expect(dashboard).toContain("Authorization: `Bearer ${state.session.token}`");
    expect(dashboard).toContain("state.session?.token === 'preview-token'");
    expect(dashboard).toContain("/api/follow-radar/events");
    expect(schema).toContain('UNIQUE("user_id", "event_id")');
    expect(worker).toContain('WHERE user_id = ?');
  });

  it('服务器按会员状态保护同步接口，并保留取消会员后的三十天只读历史', () => {
    expect(worker).toContain('getFollowRadarAccess(c, true)');
    expect(worker).toContain('mode: "last_30_days"');
    expect(worker).toContain('membership_required');
  });
});
