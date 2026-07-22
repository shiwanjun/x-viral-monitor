# Privacy Policy — X Viral Monitor

**Last updated:** July 2026

## Summary
X Viral Monitor does not sell data or use analytics, telemetry, or tracking pixels. Timeline analysis and caches stay in your browser. Network requests are limited to X, services needed for extension operation, and an AI provider only when you configure and use one.

## What the extension accesses

- **X GraphQL API responses**: The extension hooks into the network calls that X's website already makes and reads tweet metrics (view counts, likes, retweets, replies, bookmarks, post timestamps) from those responses. No copies leave your browser.
- **X same-origin endpoints**: For the Star Chart, Grok Reply, and optional bookmark-folder timeline features, the extension calls X's own endpoints (e.g. `grok.x.com`, X GraphQL) using your existing X session — the same way the X web app does. When bookmark-folder timeline injection is enabled, selected folders are refreshed in the background at most once every 30 minutes while an X tab is open. No bookmark data is sent to third-party servers.
- **Page DOM on x.com / pro.x.com**: To render badges, the leaderboard, the enhanced photo viewer, and the Star Chart panel directly on the X interface.
- **Optional AI providers**: If you select an OpenAI-compatible provider and request a reply draft, the prompt and relevant tweet text are sent directly from your browser to that provider under its privacy policy. XVM does not proxy or retain that content.
- **Operational services**: The extension can download filter-rule updates from GitHub and contact the XVM license service for Pro activation and validation. These requests do not include tweet or browsing content.

## Local storage usage

- **chrome.storage.sync** (synced via your Google account): your trending/viral velocity thresholds, badge style, leaderboard preferences, prompt templates, general feature toggles, and configured provider settings. Bookmark-folder selection, its account ID, and bookmark tweet content are never synced.
- **chrome.storage.local** (this device only): a small Star Chart query template cache, short-lived Star Chart result caches, and—only when bookmark-folder timeline injection is enabled—the device-specific toggle/folder selection, a cache of tweet entries from those folders, and the numeric X account ID used to prevent cache mixing. The bookmark cache is limited to 2 MB and 120 entries per folder, expires after 24 hours, and is cleared when the feature is disabled, all folders are deselected, or the X account changes. It is never synced or sent to XVM servers.

## What the extension does NOT do

- Does not sell personal information or use it for advertising
- Does not track browsing history
- Does not use analytics, telemetry, or tracking services
- Does not inject ads
- Does not access or store login credentials or passwords
- Does not send bookmark caches, browsing history, or X credentials to XVM servers

## Open source

The full source code is publicly available at:
https://github.com/Icy-Cat/x-viral-monitor

## Contact

For questions about this privacy policy, please open an issue on the GitHub repository.
