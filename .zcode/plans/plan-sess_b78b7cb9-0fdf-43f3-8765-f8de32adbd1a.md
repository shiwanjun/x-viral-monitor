## 任务三件事

1. **安装 baoyu-design skill** —— `npx skills add JimLiu/baoyu-design`,装到 `~/.agents/skills/baoyu-design`(本环境的 skill 根)。它是 claude.ai/design 引擎的本地包装,提供"设计 token 锁定"方法论,本身不带固定色板。
2. **删除纯 Creem 残留** —— 范围已确认:只删死代码,保留 `src/premium/license/` 全部 5 个文件(它们是新的 Waffo 订阅系统)。
3. **重新设计 popup 5 个 tab + 版本号统一 V1.0.0** —— 把割裂的双调色板重构为统一的语义化 design token 架构(为后期多主题打基础)。

---

## 第一部分:安装 baoyu-design skill

```bash
npx skills add JimLiu/baoyu-design
```
装到 `~/.agents/skills/baoyu-design`。装完验证 SKILL.md 存在。这一步不动业务代码。

---

## 第二部分:删除纯 Creem 残留

| 文件 | 操作 | 说明 |
|------|------|------|
| `worker/license-proxy.js` | **整文件删除** | 纯 Creem 代理,ADR-0005 标记为待删 |
| `worker/wrangler.toml` | **整文件删除** | 部署 xvm-license worker 的配置 |
| `background.js` L5-6, 404-423 | **删除这几段** | `LICENSE_PROXY_URL`/`LICENSE_PROXY_ACTIONS` 常量 + `callLicenseProxy()` + `XVM_LICENSE_PROXY` handler。保留 `XVM_AUTH_TOKEN` handler(L430-453) |
| `manifest.json` L23 | **删除一行** | host permission `https://xvm-license.lengkuxiaomao.workers.dev/*` |
| `popup-dashboard.js` L123-151 | **删除** | `wireProNav()` + `wireActivateCancel()` —— 已删的 `#activate-inline` 表单的死 handler |
| `tests/premium-license-slice.test.js` L73-77, 97-102 | **反转断言** | 从"保留 legacy Creem"改为"legacy 已删除"(否则测试会失败) |
| `worker/DEPLOY.md` L130-138 | **删除** | "Legacy worker" 段 |
| `secrets/README.md` | **删除 legacy 段** | 引用已不存在的 3 个文件 |
| `secrets/` 下 3 个文件 | **删除** | `xvm-entitlement-private-key.jwk`/`worker-secrets.json`/`upload-to-worker.ps1`(若存在) |

**保留不动**(关键):`src/premium/license/` 全部 5 个文件(entitlement.js / tier-logic.js / gate.js / isolated.js / popup-pro.js)、`worker/src/` + `worker/lib/` + `worker/auth/`、`auth-callback.*`、`window.__xvmPro` gate API、14 天 trial + 7 天离线宽限、`manifest.json` 的 `x.jieyiai.dev` + `pancake.waffo.ai` host 权限。

---

## 第三部分:重新设计 popup 5 个 tab + 版本统一

### Design Token 架构(核心改动)

把现在割裂的 `:root`(暖沙) + `body[data-theme="dark"]`(shadcn) 重构为**三层 token**:

```
Layer 1 — 原始调色板(primitive): --blue-500, --slate-900, --orange-600 ...
Layer 2 — 语义 token(组件引用这层): --color-bg, --color-surface, --color-text,
          --color-accent, --radius-card, --space-4, --shadow-sm ...
Layer 3 — 组件类(.panel-card, .tab-btn, .adv-btn ...) 只用 Layer 2
```

主题(light/dark)只重写 Layer 2 的赋值。后期加新主题 = 加一个 `[data-theme="xxx"]` 块重写 Layer 2,Layer 1 和 Layer 3 不动。这是后期多主题方案的架构基础。

**默认主题选定**:以现有 shadcn slate/cyan 为基准统一(用户确认"统一主题"),light theme 作为第二主题保留(语义层重写即可),不再有两套 ad-hoc 调色板。

### popup.html 重写范围
- 重写 `<style>` 块(L7-703):三 token 层 + 规范化间距 scale(`--space-1..8`)、圆角 scale(`--radius-sm/md/lg/full`)、阴影 scale、字体 scale。
- 5 个 tab 的组件类全部对齐到 Layer 2 token:Pro(`.pro-banner`/`.pro-plan-card`/`.tier-big`)、Filter(`.rf-section`/`.cf-section`/`.xvm-select`)、Leaderboard(`.panel-card`/`.info-box`/`.feature-row`/`.switch`)、AI(`.ai-provider-card`/`.ai-provider-option`)、About(`.rf-row`/`.footer-line`)。
- header/tier-chip/tabbar/footer 按新 token 重做。
- **结构/DOM/JS 钩子保持不变**(所有 `id`/`class`/`data-*` 钩子、`popup-*.js` 的渲染入口、`data-i18n` key 全部保留),只动视觉层。这样 popup-pro.js / popup-dashboard.js / popup-rate-filter.js 等不用改。

### popup-pro.js 微调
DOM 结构不动,但内联创建的元素(`.pro-plan-card`/`.tier-big` 等)的 inline style 对齐到新 token class。改动最小化。

### 版本号统一 V1.0.0
- `manifest.json:4` —— 已是 `"1.0.0"` ✅(确认无需改)
- `package.json:3` / `worker/package.json:3` —— 已是 `"1.0.0"` ✅
- `popup.html:756` 硬编码 `Coming in v1.8.0` → 改为 `V1.0.0`(或移除版本号,改为中性文案)
- `popup.html:14` 注释 `from v1.6.x` → 更新
- `CHANGELOG.md` —— 保留历史不动(不重写历史),在 `[Unreleased]` 下加一条记录本次重构
- 运行时 `#popup-version` 由 `chrome.runtime.getManifest().version` 注入,自动显示 1.0.0

---

## 不做的事(避免误伤)
- 不删 14 天 trial / 7 天离线宽限 / ECDSA 本地 entitlement 校验(ADR-0005 保留)
- 不动 `src/premium/license/` 5 个文件的逻辑(只 popup-pro.js 视觉微调)
- 不动 `worker/src/` / `worker/lib/` / `worker/auth/`
- 不动 i18n key 体系(只可能新增几个 design 相关的 key)
- 不重写 CHANGELOG 历史
- JIEYI store 误建产品清理是独立任务,本次不碰

## 验证
- `npm test` —— 确保反转后的 2 个 Creem 断言 + 其余 premium 测试全过
- 浏览器加载扩展,目视检查 5 个 tab 在 light/dark 下的视觉
- 切换主题验证 token 架构生效

## 执行顺序
1. 安装 skill(独立,5 秒)
2. 删 Creem 残留(机械操作,先做,降低后续 diff 噪音)
3. 改测试断言 + 跑测试确认绿
4. 重构 popup.html design token + 5 tab 重做(主工作量)
5. popup-pro.js 视觉对齐
6. 版本号统一
7. 最终验证

要我开始吗?第二、三部分改动较大,我会分步提交、每步跑测试。