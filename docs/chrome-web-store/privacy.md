# Chrome Web Store - 隐私权 (Privacy)

> 编辑页面: https://chrome.google.com/webstore/devconsole/ea0eccb4-2164-4994-a688-53acfdb73acc/dkplofpecmjmbhgjgleeflcnfgfkdfpd/edit/privacy

## 单一用途说明 (Single Purpose)

```
Augment the X (Twitter) timeline reading and engagement experience: surface tweet impression velocity as inline badges, improve in-page media viewing (including long screenshots), and provide local helper tools (copy-as-Markdown, supporter visualization, Grok reply drafting) that operate solely on the X page the user is currently viewing.
```

## 权限说明

### 需请求 storage 的理由 (justification for `storage`)

```
chrome.storage is used to persist user preferences and cache data locally in the browser. Specifically:

• chrome.storage.sync — user-configurable thresholds (Trending / Viral views-per-hour), badge style, leaderboard column order, Grok prompt template, and general feature toggles. These follow the user across devices; bookmark-folder selection does not.

• chrome.storage.local — Star Chart query template/result caches and, only when bookmark-folder timeline injection is enabled, its device-specific toggle/folder selection, a cache of tweet entries from those folders, and the numeric X account ID used to prevent cross-account cache mixing. The bookmark cache is limited to 2 MB and 120 entries per folder, expires after 24 hours, and is cleared on disable, deselection, or X account change. It is never synced or transmitted to X-Tools servers.

No browsing history or login credentials are stored. Cached bookmark tweet entries remain on the device and exist only to render the user-selected folders in the X timeline.
```

### 需请求主机权限的理由 (justification for host access)

```
The extension declares content scripts on https://x.com/* and https://pro.x.com/*. It needs to run on those pages to:

(1) Hook the page's existing fetch/XHR calls so it can read tweet metrics (views, likes, retweets) from X's GraphQL responses already arriving for the timeline.

(2) Render velocity badges, the hot-on-page leaderboard, the enhanced photo/long-image viewer, and the Star Chart panel directly on the X DOM.

(3) Call X's same-origin endpoints (e.g., grok.x.com for the Grok reply feature, X GraphQL for the Star Chart) — same endpoints the X web app itself uses, called from the same origin with the user's existing session.

The extension also requests host permissions for user-configured AI providers, GitHub-hosted filter rule updates, and the X-Tools license Worker used to activate and validate Pro subscriptions. It does not send analytics or telemetry.
```

## 远程代码

- **是否使用远程代码**: 否
- 所有 JavaScript 在打包内随扩展一同分发；扩展不通过 `eval` / 远程脚本注入等方式加载外部代码。

## 数据使用声明 - 收集的数据类型

数据类型勾选状态如下：

- [x] 个人身份信息（仅本地保存用于书签缓存隔离的 X 数字账号 ID）
- [ ] 健康信息
- [ ] 财务和付款信息
- [ ] 身份验证信息
- [ ] 个人通讯
- [ ] 位置
- [ ] 网络记录
- [ ] 用户活动
- [x] 网站内容（仅在本机处理；包含用户主动启用后短期缓存的所选书签推文）

> 说明：扩展会**读取** X 页面上的推文指标（views/likes/RT 等）和 Star Chart 的转发者公开列表；用户主动开启书签文件夹时间线后，还会在本机短期缓存所选文件夹的推文条目。只有用户主动配置并使用外部 AI 回复服务时，相关提示词与推文正文会直连发送给该服务商；书签缓存不会发送到 X-Tools 或第三方服务器。

## 数据使用声明 - 合规承诺

以下三项均**已勾选**：

- [x] 我不会出于已获批准的用途之外的用途向第三方出售或传输用户数据
- [x] 我不会为实现与我的产品的单一用途无关的目的而使用或转移用户数据
- [x] 我不会为确定信用度或实现贷款而使用或转移用户数据

## 隐私权政策网址

```
https://x.jieyiai.dev/privacy.html
```

> 公开隐私政策位于 `docs/privacy.html`；`store-assets/privacy-policy.md` 保留为仓库内的完整政策源稿，二者应在每次发布前同步复核。
