(() => {
  'use strict';
  const state = { extensionId: '', connected: false, siteSession: null, subscription: null, extensionStatus: null, section: 'library', kind: 'all', folderId: '', tagId: '', search: '', media: '', from: 0, to: 0, cursor: null, cursorStack: [], rows: [], selected: new Set(), counts: {}, tags: [], folders: [], savedFilters: [], quota: { used: 0, limit: 1000, locked: 0 }, sync: {}, view: 'table', relations: { users: [], events: [], counts: {} }, relationFilter: 'all', relationSearch: '', unfollowFilter: 'all', unfollowSearch: '' };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  const number = (value) => new Intl.NumberFormat('zh-CN', { notation: Number(value) > 9999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value) || 0);
  const date = (value) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
  const kindName = { all: '全部内容', bookmark: '书签', like: '点赞', authored_post: '我的推文', authored_reply: '我的回复' };
  let toastTimer;

  function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2600); }
  function externalMessage(id, message) { return new Promise((resolve) => { try { chrome.runtime.sendMessage(id, message, (response) => resolve(chrome.runtime.lastError ? null : response)); } catch (_) { resolve(null); } }); }
  async function extensionIds() { try { const response = await fetch('/api/extension-handoff/config', { credentials: 'include' }); const data = await response.json(); if (data.libraryWorkspaceEnabled === false) banner('loading', '数据中心灰度中', '当前生产路由尚未开启，请使用测试环境完成真实账号验收。', '刷新'); return data.extensionIds || []; } catch (_) { return []; } }
  async function send(message) {
    const ids = state.extensionId ? [state.extensionId] : await extensionIds();
    for (const id of ids) { const response = await externalMessage(id, message); if (response) { state.extensionId = id; state.connected = true; return response; } }
    state.connected = false; return { ok: false, error: 'extension_not_connected' };
  }
  function banner(mode, title, copy, action = '重试') { const el = $('#connection-banner'); el.className = `banner ${mode}`; el.querySelector('strong').textContent = title; el.querySelector('small').textContent = copy; $('#banner-action').textContent = action; }
  function errorText(code) { return ({ unauthorized: '请先登录 X-Tools', membership_required: '此功能需要 Pro 会员', account_mismatch: '检测到 X 账号切换，请切回已绑定账号', x_account_required: '请先打开 X 并绑定当前账号', quota_exceeded: '已达到当前会员额度', rate_limited: 'X 暂时限流，已自动暂停', cursor_conflict: '云端游标冲突，请重新拉取', x_tab_required: '请先打开一个 X 页面', extension_not_connected: '扩展未连接', cloud_sync_disabled: '请先开启关系云同步', missing_query_template: '请先访问对应的 X 页面，让扩展发现查询模板' })[code] || code || '操作失败'; }
  const isPro = () => state.subscription?.tier === 'pro' || Boolean(state.extensionStatus?.isPro);

  function initials(user) { const value = String(user?.name || user?.email || 'XT').trim(); return [...value].slice(0, 2).join('').toUpperCase(); }
  function renderAccount() {
    const user = state.siteSession?.user || null; const extension = state.extensionStatus;
    const pro = isPro(); const signedIn = Boolean(user);
    $('#account-name').textContent = signedIn ? (user.name || 'X-Tools 用户') : '未登录 X-Tools';
    $('#account-email').textContent = signedIn ? (user.email || '官网账号已登录') : '登录后同步会员与标签';
    $('#account-tier').textContent = signedIn ? `${pro ? 'PRO · 100K' : 'FREE · 1K'}${extension?.signedIn ? ' · 扩展已连接' : ' · 扩展待同步'}` : 'FREE · 本地模式';
    $('#account-avatar').textContent = initials(user); $('#account-avatar').style.backgroundImage = user?.image ? `url(${JSON.stringify(user.image).slice(1, -1)})` : '';
    $('#account-action').textContent = signedIn ? '退出' : '登录';
    $('#auth-button').classList.toggle('is-authenticated', signedIn); $('#auth-button b').textContent = signedIn ? (pro ? 'Pro 会员' : '已登录') : '登录';
  }
  async function refreshSiteSession() {
    try {
      const response = await fetch('/api/auth/get-session', { credentials: 'include', headers: { Accept: 'application/json' } });
      state.siteSession = response.ok ? await response.json() : null;
      if (state.siteSession?.user) {
        const subscription = await fetch('/api/subscription/status', { credentials: 'include', headers: { Accept: 'application/json' } });
        state.subscription = subscription.ok ? await subscription.json() : null;
      } else state.subscription = null;
    } catch (_) { state.siteSession = null; state.subscription = null; }
    renderAccount();
  }
  async function startSignIn() {
    if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') { toast('本地预览不共享线上登录 Cookie，请在官网 /workspace 登录'); return; }
    try { const response = await fetch('/api/auth/sign-in/social', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ provider: 'google', callbackURL: location.href }) }); const data = await response.json(); const url = data?.url || data?.redirectURL || data?.redirect; if (!response.ok || !url) throw new Error(); location.assign(url); } catch (_) { toast('暂时无法开始登录，请稍后重试'); }
  }
  async function handleAccountAction() { if (!state.siteSession?.user) return startSignIn(); await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' }).catch(() => null); if (state.extensionId) await externalMessage(state.extensionId, { type: 'XVM_WEBSITE_AUTH_SIGN_OUT' }); state.siteSession = null; renderAccount(); toast('已退出登录'); }

  async function refreshStatus() {
    const result = await send({ type: 'XVM_LIBRARY_STATUS' });
    if (!result.ok) { banner('error', '扩展未连接', '请安装或重新加载最新版 X-Tools，然后刷新此页面。', '重新检测'); renderEmpty(true); return; }
    state.extensionStatus = result; state.counts = result.counts || {}; state.tags = result.tags || []; state.folders = result.folders || []; state.quota = result.quota || state.quota; state.sync = result.sync || {};
    banner(result.sync?.status === 'rate_limited' ? 'error' : 'ok', result.sync?.status === 'running' ? '正在同步' : '扩展已连接', result.sync?.status === 'rate_limited' ? 'X 已限流，扩展将指数退避后继续。' : `本地数据库可用 · ${result.account?.accountId ? `已绑定 X ID ${result.account.accountId}` : '等待绑定 X 账号'}`, result.sync?.status === 'running' ? '暂停' : '刷新');
    renderAccount();
    $('#cloud-state').textContent = result.cloudBackup ? (result.readOnly ? '只读保留' : '已开启') : '未开启'; $('#cloud-toggle').textContent = result.cloudBackup ? '管理' : '开启';
    const operations = new Set(result.availableOperations || []); $('#full-sync').disabled = !['Bookmarks', 'BookmarkFolderTimeline', 'Likes', 'UserTweets', 'UserTweetsAndReplies'].some((operation) => operations.has(operation)); $('#full-sync').title = $('#full-sync').disabled ? '先打开 X 的书签、点赞或个人页，扩展会自动发现查询模板' : '';
    $('#last-sync').textContent = result.sync?.lastSyncedAt ? `最近 ${date(result.sync.lastSyncedAt)}` : '尚未同步'; renderFacets(); renderQuota(); await Promise.all([query(true), refreshSavedFilters()]);
  }

  function renderFacets() {
    const total = Object.values(state.counts).reduce((sum, value) => sum + Number(value || 0), 0); $('#count-all').textContent = number(total);
    Object.entries(state.counts).forEach(([key, value]) => { const el = $(`#count-${key}`); if (el) el.textContent = number(value); });
    $('#folders').innerHTML = `<button class="facet ${!state.folderId ? 'active' : ''}" data-folder=""><i></i>全部文件夹</button>${state.folders.map((folder) => `<button class="facet ${state.folderId === folder.id ? 'active' : ''}" data-folder="${esc(folder.id)}"><i style="background:${esc(folder.color)}"></i>${esc(folder.name)}</button>`).join('')}`;
    $('#tags').innerHTML = state.tags.map((tag) => `<button class="facet ${state.tagId === tag.id ? 'active' : ''}" data-tag="${esc(tag.id)}"><i style="background:${esc(tag.color)}"></i>${esc(tag.name)}</button>`).join('') || '<span class="nav-title">暂无标签</span>';
  }
  function renderSavedFilters() {
    const host = $('#saved-filters');
    host.innerHTML = state.savedFilters.length ? `<span>智能筛选</span>${state.savedFilters.map((filter) => `<button type="button" data-apply-filter="${esc(filter.id)}">${esc(filter.name)}</button><button type="button" class="saved-filter-remove" data-delete-filter="${esc(filter.id)}" aria-label="删除 ${esc(filter.name)}">×</button>`).join('')}` : '';
  }
  async function refreshSavedFilters() {
    const result = await send({ type: 'XVM_LIBRARY_MUTATE', payload: { action: 'list_filters' } });
    state.savedFilters = result.ok ? (result.items || []) : [];
    renderSavedFilters();
  }
  async function applyFilter(savedQuery = {}) {
    state.kind = savedQuery.kind || 'all'; state.folderId = savedQuery.folderId || ''; state.tagId = savedQuery.tagId || ''; state.search = savedQuery.search || ''; state.media = savedQuery.media || ''; state.from = Number(savedQuery.from || 0); state.to = Number(savedQuery.to || 0);
    $('#search').value = state.search; $('#media-filter').value = state.media; $('#date-from').value = state.from ? new Date(state.from).toISOString().slice(0, 10) : ''; $('#date-to').value = state.to ? new Date(state.to).toISOString().slice(0, 10) : '';
    $$('#kind-nav [data-kind]').forEach((item) => item.classList.toggle('active', item.dataset.kind === state.kind)); renderFacets(); showSection('library'); await query(true);
  }
  function renderQuota() { $('#stat-used').textContent = number(state.quota.used); $('#quota-copy').textContent = `${state.quota.tier === 'pro' ? 'Pro' : 'Free'} 额度 ${number(state.quota.limit)}`; $('#quota-wall').hidden = !state.quota.locked; $('#locked-count').textContent = number(state.quota.locked); }
  function queryPayload() { return { kind: state.kind, folderId: state.folderId, tagId: state.tagId, search: state.search, media: state.media, from: state.from, to: state.to, cursor: state.cursor, limit: 50 }; }
  async function query(reset = false) {
    if (reset) { state.cursor = null; state.cursorStack = []; }
    const result = await send({ type: 'XVM_LIBRARY_QUERY', query: queryPayload() });
    if (!result.ok) { toast(errorText(result.error)); return; }
    state.rows = result.rows || []; state.nextCursor = result.cursor; state.quota = result.quota || state.quota; renderQuota(); renderViews();
  }
  function typePill(kind) { return `<span class="type-pill">${esc(kindName[kind] || kind)}</span>`; }
  function chips(row) { const tags = (row.tags || []).map((item) => `<span class="chip"># ${esc(item.name)}</span>`); const folders = (row.folders || []).map((item) => `<span class="chip">▱ ${esc(item.name)}</span>`); if (row.item.sourceFolderName) folders.push(`<span class="chip">X · ${esc(row.item.sourceFolderName)}</span>`); return [...tags, ...folders].join('') || '<span class="chip">未整理</span>'; }
  function renderTable() {
    $('#rows').innerHTML = state.rows.map(({ item, post, tags, folders }) => {
      const row = { item, post, tags, folders }; const image = post.media?.[0]?.previewUrl || post.authorAvatar;
      return `<tr><td><input class="row-check" type="checkbox" data-id="${esc(item.id)}" ${state.selected.has(item.id) ? 'checked' : ''}></td><td><div class="post">${image ? `<img class="thumb" src="${esc(image)}" alt="" loading="lazy">` : '<span class="thumb"></span>'}<div class="post-body"><div class="post-copy">${esc(post.text || '无正文')}</div><div class="post-meta">${esc(post.authorName)} · @${esc(post.authorHandle)}${item.sourceRemovedAt ? ' · <b>来源已删除</b>' : ''}</div></div></div></td><td>${typePill(item.kind)}</td><td>${chips(row)}</td><td><div class="metric"><b>♥ ${number(post.metrics?.likes)}</b><small>◉ ${number(post.metrics?.views)}</small></div></td><td>${date(post.createdAt)}</td><td><button class="row-more" data-row="${esc(item.id)}">•••</button></td></tr>`;
    }).join('');
  }
  function renderGallery() { $('#view-gallery').innerHTML = state.rows.map(({ item, post }) => `<article class="gallery-card">${post.media?.[0]?.previewUrl ? `<img src="${esc(post.media[0].previewUrl)}" alt="" loading="lazy">` : '<div class="gallery-placeholder">✎</div>'}<div><span>${typePill(item.kind)}</span><strong>${esc(post.text || '无正文')}</strong><small>@${esc(post.authorHandle)} · ${date(post.createdAt)}</small></div></article>`).join(''); }
  function renderStats() {
    const colors = ['#654fe8', '#4aa3f4', '#f08d43', '#42ba82']; const entries = ['bookmark', 'like', 'authored_post', 'authored_reply'].map((kind, i) => ({ kind, value: Number(state.counts[kind] || 0), color: colors[i] })); const total = Math.max(1, entries.reduce((sum, item) => sum + item.value, 0)); let cursor = 0;
    $('#kind-chart').style.background = `conic-gradient(${entries.map((item) => { const start = cursor; cursor += item.value / total * 100; return `${item.color} ${start}% ${cursor}%`; }).join(',')})`;
    $('#stats-legend').innerHTML = entries.map((item) => `<div class="legend-row"><i style="background:${item.color}"></i><span>${kindName[item.kind]}</span><b>${number(item.value)}</b></div>`).join('');
  }
  function renderEmpty(disconnected = false) { const empty = $('#empty'); empty.hidden = disconnected ? false : (state.rows.length > 0 || state.view === 'stats'); $('#view-table').hidden = disconnected || !state.rows.length || state.view !== 'table'; $('#view-gallery').hidden = disconnected || !state.rows.length || state.view !== 'gallery'; $('#view-stats').hidden = disconnected || state.view !== 'stats'; }
  function renderViews() { renderTable(); renderGallery(); renderStats(); renderEmpty(); $('#range').textContent = state.rows.length ? `本页 ${state.rows.length} 条 · 共 ${number(state.quota.used)} 条` : '0 条'; $('#prev').disabled = !state.cursorStack.length; $('#next').disabled = !state.nextCursor; $('#stat-today').textContent = Object.values(state.sync.operations || {}).reduce((sum, op) => sum + Number(op.captured || 0), 0) || '0'; $('#stat-removed').textContent = state.rows.filter((row) => row.item.sourceRemovedAt).length; updateSelection(); }
  function updateSelection() { $('#selected-count').textContent = state.selected.size; $('#batch-bar').hidden = !state.selected.size; $('#select-all').checked = state.rows.length > 0 && state.rows.every((row) => state.selected.has(row.item.id)); }

  function relationshipKind(user) { return user.f && user.b ? 'mutual' : user.f ? 'mine' : user.b ? 'theirs' : (user.u || user.i) ? 'unfollowed' : 'none'; }
  function relationshipLabel(kind) { return ({ mutual: '互关', mine: '我关注', theirs: '关注我', unfollowed: '已取关', none: '关注率' })[kind] || kind; }
  function relationshipRate(user) { const followers = Number(user.fc || 0); return followers > 0 ? (Number(user.fd || 0) / followers).toFixed(2) : '—'; }
  function renderRelationships() {
    const counts = state.relations.counts || {};
    $('#relation-mutual').textContent = number(counts.mutual); $('#relation-mine').textContent = number(counts.mine); $('#relation-theirs').textContent = number(counts.theirs); $('#relation-unfollowed').textContent = number(counts.unfollowed);
    $('#count-relations').textContent = number((counts.mutual || 0) + (counts.mine || 0) + (counts.theirs || 0)); $('#count-unfollow').textContent = number(state.relations.events.length);
    const needle = state.relationSearch.toLocaleLowerCase();
    const users = state.relations.users.filter((user) => (state.relationFilter === 'all' || relationshipKind(user) === state.relationFilter) && (!needle || `${user.n || ''} ${user.handle}`.toLocaleLowerCase().includes(needle)));
    $('#relation-list').innerHTML = users.length ? users.map((user) => { const kind = relationshipKind(user); return `<article class="relation-row"><div class="relation-user"><span class="relation-avatar">${esc((user.n || user.handle || 'X').slice(0, 1).toUpperCase())}</span><div><strong>${esc(user.n || user.handle)}</strong><small>@${esc(user.handle)}</small></div></div><span class="relation-pill ${kind}">${relationshipLabel(kind)}</span><span class="relation-rate">${relationshipRate(user)}</span><span class="relation-date">${date(user.t)}</span></article>`; }).join('') : '<div class="insight-empty">暂无匹配的关系数据，请先在 X 的关注或粉丝页完成扫描。</div>';
    const eventNeedle = state.unfollowSearch.toLocaleLowerCase();
    const events = state.relations.events.filter((event) => (state.unfollowFilter === 'all' || event.type === state.unfollowFilter) && (!eventNeedle || `${event.n || ''} ${event.h || ''}`.toLocaleLowerCase().includes(eventNeedle)));
    $('#unfollow-list').innerHTML = events.length ? events.map((event) => `<article class="unfollow-row"><div class="relation-user"><span class="relation-avatar">${esc((event.n || event.h || 'X').slice(0, 1).toUpperCase())}</span><div><strong>${esc(event.n || event.h)}</strong><small>@${esc(event.h)}</small></div></div><span class="relation-pill unfollowed">${event.type === 'i_unfollowed' ? '我取关 TA' : 'TA 取关我'}</span><span class="relation-rate">${Number(event.fc) > 0 ? (Number(event.fd || 0) / Number(event.fc)).toFixed(2) : '—'}</span><span class="relation-date">${date(event.ts)}</span></article>`).join('') : '<div class="insight-empty">暂无取关记录。</div>';
    $('#unfollow-gate').hidden = isPro(); $('#unfollow-content').hidden = !isPro();
    $('#relationship-cloud').textContent = state.relations.cloudSync ? '云同步已开启' : '云同步 PRO';
    $('#relationship-sync').disabled = !state.relations.cloudSync;
  }
  async function refreshRelationships() { const result = await send({ type: 'XVM_LIBRARY_RELATIONSHIPS' }); if (result.ok) state.relations = result; renderRelationships(); if (!result.ok) toast(errorText(result.error)); }
  function showSection(section) {
    state.section = section; $('#library-screen').hidden = section !== 'library'; $('#relations-screen').hidden = section !== 'relations'; $('#unfollow-screen').hidden = section !== 'unfollow';
    $$('#kind-nav .nav-item').forEach((item) => item.classList.toggle('active', item.dataset.section === section || (section === 'library' && item.dataset.kind === state.kind)));
    const titles = { library: kindName[state.kind], relations: '关注关系', unfollow: '取关历史' }; $('#page-title').textContent = titles[section];
    $('#search').hidden = section !== 'library'; $('#filter-toggle').hidden = section !== 'library'; $('#sync').hidden = section !== 'library';
    const url = new URL(location.href); if (section === 'library') url.searchParams.delete('section'); else url.searchParams.set('section', section); history.replaceState(null, '', url);
    if (section !== 'library') refreshRelationships();
  }

  function openDialog({ eyebrow = 'X-TOOLS', title, copy = '', body = '', confirm = '确认', danger = false, onConfirm }) { $('#dialog-eyebrow').textContent = eyebrow; $('#dialog-title').textContent = title; $('#dialog-copy').textContent = copy; $('#dialog-body').innerHTML = body; $('#dialog-confirm').textContent = confirm; $('#dialog-confirm').style.background = danger ? '#d34d55' : ''; $('#dialog-confirm').onclick = (event) => { event.preventDefault(); Promise.resolve(onConfirm?.()).then(() => $('#dialog').close()); }; $('#dialog').showModal(); }
  async function createFacet(type) { openDialog({ title: `新建${type === 'tag' ? '标签' : '文件夹'}`, copy: '名称会保存到本地，并在开启云备份后同步。', body: '<input id="new-facet-name" maxlength="80" placeholder="输入名称"><input id="new-facet-color" type="color" value="#654fe8">', onConfirm: async () => { const result = await send({ type: 'XVM_LIBRARY_MUTATE', payload: { action: `create_${type}`, name: $('#new-facet-name').value, color: $('#new-facet-color').value } }); if (!result.ok) toast(errorText(result.error)); else { toast('创建成功'); await refreshStatus(); } } }); }
  async function assign(type) { const list = type === 'tag' ? state.tags : state.folders; if (!list.length) { toast(`请先新建${type === 'tag' ? '标签' : '文件夹'}`); return; } openDialog({ title: type === 'tag' ? '批量添加标签' : '批量移动到文件夹', body: `<select id="assign-target">${list.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select>`, onConfirm: async () => { const result = await send({ type: 'XVM_LIBRARY_MUTATE', payload: { action: `assign_${type}`, itemIds: [...state.selected], targetId: $('#assign-target').value } }); if (!result.ok) toast(errorText(result.error)); else { toast('整理完成'); state.selected.clear(); await query(true); } } }); }
  async function sync(mode) { const result = await send({ type: 'XVM_LIBRARY_SYNC_START', payload: { mode } }); toast(result.ok ? '同步已开始，请保持 X 页面打开' : errorText(result.error)); await refreshStatus(); }
  function xActionDialog() { openDialog({ eyebrow: 'PRO · X 写操作', title: '同步删除 X 来源？', copy: '将串行执行，最多 50 条。删除本人推文不可恢复；默认的“本地归档”不会触碰 X。', danger: true, confirm: '我已了解，继续', body: '<select id="x-operation"><option value="DeleteBookmark">取消书签</option><option value="UnfavoriteTweet">取消点赞</option><option value="DeleteTweet">删除本人推文（不可恢复）</option></select>', onConfirm: async () => { const postIds = state.rows.filter((row) => state.selected.has(row.item.id)).map((row) => row.post.id); const result = await send({ type: 'XVM_LIBRARY_X_ACTION', payload: { operation: $('#x-operation').value, postIds } }); toast(result.ok ? `已完成 ${result.results?.filter((item) => item.ok).length || 0}/${postIds.length}` : errorText(result.error)); } }); }
  function download(content, type, ext) { const blob = new Blob([content], { type }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `x-tools-${Date.now()}.${ext}`; link.click(); URL.revokeObjectURL(link.href); }
  function printRows(rows) { const popup = window.open('', '_blank', 'noopener,noreferrer'); if (!popup) return toast('浏览器拦截了打印窗口，请允许弹窗后重试'); popup.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>X-Tools 导出</title><style>body{font:14px/1.7 -apple-system,"PingFang SC",sans-serif;color:#17151f;padding:32px}h1{font-size:24px}article{break-inside:avoid;border-bottom:1px solid #ddd;padding:14px 0}small{color:#706b7c}</style></head><body><h1>X-Tools 数据导出 · ${rows.length} 条</h1>${rows.map(({ item, post }) => `<article><strong>${esc(post.authorName)} (@${esc(post.authorHandle)})</strong><p>${esc(post.text)}</p><small>${esc(kindName[item.kind])} · ${esc(new Date(post.createdAt).toLocaleString('zh-CN'))}</small></article>`).join('')}</body></html>`); popup.document.close(); popup.focus(); popup.print(); }
  async function allFilteredRows() { if (state.quota.tier !== 'pro') { const selected = state.rows.find((row) => state.selected.has(row.item.id)); return [selected || state.rows[0]].filter(Boolean); } const rows = []; let cursor = null; do { const result = await send({ type: 'XVM_LIBRARY_EXPORT', query: { ...queryPayload(), cursor }, format: 'json' }); if (!result.ok) throw new Error(result.error); rows.push(...(result.rows || [])); cursor = result.cursor; } while (cursor && rows.length < 100000); return rows; }
  function exportRows() { openDialog({ title: '导出数据', copy: state.quota.tier === 'pro' ? 'Pro 将按游标读取全部匹配内容后导出。' : 'Free 支持单条 JSON / Markdown；批量 CSV、PDF 和媒体清单需要 Pro。', body: `<select id="export-format"><option value="json">JSON</option><option value="markdown">Markdown</option><option value="csv" ${state.quota.tier !== 'pro' ? 'disabled' : ''}>CSV · PRO</option><option value="pdf" ${state.quota.tier !== 'pro' ? 'disabled' : ''}>PDF · PRO</option><option value="media" ${state.quota.tier !== 'pro' ? 'disabled' : ''}>媒体链接清单 · PRO</option></select>`, confirm: '导出', onConfirm: async () => { const rows = await allFilteredRows(); const format = $('#export-format').value; if (format === 'json') download(JSON.stringify(rows.map(({ item, post }) => ({ type: item.kind, ...post })), null, 2), 'application/json', 'json'); if (format === 'markdown') download(rows.map(({ item, post }) => `## ${post.authorName} (@${post.authorHandle})\n\n${post.text}\n\n- 类型：${kindName[item.kind]}\n- 时间：${new Date(post.createdAt).toISOString()}`).join('\n\n---\n\n'), 'text/markdown', 'md'); if (format === 'csv') download(`id,type,author,text,createdAt\n${rows.map(({ item, post }) => [post.id, item.kind, post.authorHandle, `"${String(post.text).replaceAll('"', '""')}"`, new Date(post.createdAt).toISOString()].join(',')).join('\n')}`, 'text/csv', 'csv'); if (format === 'media') download(rows.flatMap(({ post }) => (post.media || []).map((item) => item.url)).join('\n'), 'text/plain', 'txt'); if (format === 'pdf') printRows(rows); toast(`已导出 ${rows.length} 条`); } }); }
  async function aiClassify() { const selected = state.rows.filter((row) => state.selected.has(row.item.id)); const targets = selected.length ? selected : state.rows.slice(0, 20); const result = await send({ type: 'XVM_LIBRARY_AI_CLASSIFY', payload: { rows: targets.map((row) => ({ itemId: row.item.id, text: row.post.text })) } }); toast(result.ok ? `已生成 ${result.tags.length} 个标签并整理 ${result.assigned} 条` : result.error === 'ai_provider_required' ? '请在扩展设置中配置 OpenAI 兼容接口或 Ollama' : errorText(result.error)); if (result.ok) refreshStatus(); }
  function saveFilter() { if (!isPro()) { toast('保存智能筛选需要 Pro 会员'); return; } openDialog({ eyebrow: 'PRO · SMART FILTER', title: '保存当前筛选', copy: '保存内容类型、标签、文件夹、关键词和日期条件。', body: '<input id="filter-name" maxlength="80" placeholder="筛选名称">', confirm: '保存', onConfirm: async () => { const result = await send({ type: 'XVM_LIBRARY_MUTATE', payload: { action: 'save_filter', name: $('#filter-name').value, query: queryPayload() } }); toast(result.ok ? '智能筛选已保存' : errorText(result.error)); if (result.ok) await refreshSavedFilters(); } }); }
  async function showArchive() { const result = await send({ type: 'XVM_LIBRARY_MUTATE', payload: { action: 'list_archived', limit: 100 } }); if (!result.ok) return toast(errorText(result.error)); openDialog({ title: '归档与恢复', copy: '归档快照保留 30 天。', body: `<div class="archive-list">${(result.rows || []).map(({ item, post }) => `<article class="archive-item"><div><strong>${esc(post.text || '无正文')}</strong><small>@${esc(post.authorHandle)} · ${date(item.archivedAt)}</small></div><button type="button" data-restore="${esc(item.id)}">恢复</button></article>`).join('') || '<div class="insight-empty">暂无归档内容</div>'}</div>`, confirm: '完成', onConfirm: () => {} }); $('#dialog-body').onclick = async (event) => { const id = event.target.closest('[data-restore]')?.dataset.restore; if (!id) return; const restored = await send({ type: 'XVM_LIBRARY_MUTATE', payload: { action: 'restore', itemIds: [id] } }); toast(restored.ok ? '已恢复' : errorText(restored.error)); if (restored.ok) { $('#dialog').close(); query(true); } }; }
  function rowMenu(id) { const row = state.rows.find((item) => item.item.id === id); if (!row) return; openDialog({ title: '内容操作', copy: row.post.text.slice(0, 100), body: `<div class="row-actions"><button type="button" data-row-action="open">在 X 中打开</button><button type="button" data-row-action="archive">本地归档</button><button type="button" data-row-action="tag">添加标签</button><button type="button" data-row-action="folder">移动到文件夹</button></div>`, confirm: '关闭', onConfirm: () => {} }); $('#dialog-body').onclick = async (event) => { const action = event.target.closest('[data-row-action]')?.dataset.rowAction; if (!action) return; state.selected = new Set([id]); if (action === 'open') window.open(`https://x.com/${encodeURIComponent(row.post.authorHandle)}/status/${encodeURIComponent(row.post.id)}`, '_blank', 'noopener'); if (action === 'archive') { await send({ type: 'XVM_LIBRARY_MUTATE', payload: { action: 'archive', itemIds: [id] } }); $('#dialog').close(); query(true); } if (action === 'tag' || action === 'folder') { $('#dialog').close(); assign(action); } }; }

  $('#kind-nav').addEventListener('click', (event) => { const button = event.target.closest('[data-kind]'); if (!button) return; $$('#kind-nav [data-kind]').forEach((item) => item.classList.toggle('active', item === button)); state.kind = button.dataset.kind; $('#page-title').textContent = kindName[state.kind]; query(true); });
  $('#kind-nav').addEventListener('click', (event) => { const button = event.target.closest('[data-section]'); if (button) showSection(button.dataset.section); });
  $('#folders').addEventListener('click', (event) => { const button = event.target.closest('[data-folder]'); if (!button) return; state.folderId = button.dataset.folder; renderFacets(); query(true); });
  $('#tags').addEventListener('click', (event) => { const button = event.target.closest('[data-tag]'); if (!button) return; state.tagId = state.tagId === button.dataset.tag ? '' : button.dataset.tag; renderFacets(); query(true); });
  $('#search').addEventListener('input', (() => { let timer; return (event) => { clearTimeout(timer); timer = setTimeout(() => { state.search = event.target.value; query(true); }, 280); }; })());
  $('.view-tabs').addEventListener('click', (event) => { const button = event.target.closest('[data-view]'); if (!button) return; state.view = button.dataset.view; $$('.view-tabs button').forEach((item) => item.classList.toggle('active', item === button)); renderViews(); });
  $('#rows').addEventListener('change', (event) => { const input = event.target.closest('.row-check'); if (!input) return; input.checked ? state.selected.add(input.dataset.id) : state.selected.delete(input.dataset.id); updateSelection(); });
  $('#rows').addEventListener('click', (event) => { const id = event.target.closest('[data-row]')?.dataset.row; if (id) rowMenu(id); });
  $('#select-all').addEventListener('change', (event) => { state.rows.forEach((row) => event.target.checked ? state.selected.add(row.item.id) : state.selected.delete(row.item.id)); renderTable(); updateSelection(); });
  $('#clear-selection').onclick = () => { state.selected.clear(); renderTable(); updateSelection(); };
  $('#batch-bar').addEventListener('click', async (event) => { const action = event.target.closest('[data-batch]')?.dataset.batch; if (action === 'tag' || action === 'folder') assign(action); if (action === 'archive') { const result = await send({ type: 'XVM_LIBRARY_MUTATE', payload: { action: 'archive', itemIds: [...state.selected] } }); toast(result.ok ? '已本地归档，30 天内可恢复' : errorText(result.error)); state.selected.clear(); await query(true); } if (action === 'x_action') xActionDialog(); });
  $('#filter-toggle').onclick = () => { $('#filter-panel').hidden = !$('#filter-panel').hidden; };
  $('#media-filter').onchange = (event) => { state.media = event.target.value; query(true); }; $('#date-from').onchange = (event) => { state.from = event.target.value ? new Date(`${event.target.value}T00:00:00`).getTime() : 0; query(true); }; $('#date-to').onchange = (event) => { state.to = event.target.value ? new Date(`${event.target.value}T23:59:59`).getTime() : 0; query(true); };
  $('#clear-filters').onclick = () => { state.media = ''; state.from = 0; state.to = 0; $('#media-filter').value = ''; $('#date-from').value = ''; $('#date-to').value = ''; query(true); };
  $('#sync').onclick = () => sync('incremental'); $('#empty-sync').onclick = () => sync('incremental'); $('#full-sync').onclick = () => sync('full'); $('#banner-action').onclick = () => state.sync.status === 'running' ? send({ type: 'XVM_LIBRARY_SYNC_PAUSE' }).then(refreshStatus) : refreshStatus();
  $('#add-tag').onclick = () => createFacet('tag'); $('#add-folder').onclick = () => createFacet('folder'); $('#export').onclick = exportRows;
  $('#account-action').onclick = handleAccountAction; $('#auth-button').onclick = handleAccountAction;
  $('#ai-classify').onclick = aiClassify;
  $('#cloud-toggle').onclick = () => {
    if (!state.extensionStatus?.cloudBackup) return openDialog({ eyebrow: 'PRO · 隐私授权', title: '开启云备份', copy: '将上传标准化元数据、标签、文件夹和删除状态；不会上传 X Cookie、Bearer、原始 GraphQL 响应、AI Key 或媒体文件。', body: '<label><input id="cloud-consent" type="checkbox"> 我理解并授权云端备份</label>', confirm: '授权并开启', onConfirm: async () => { if (!$('#cloud-consent').checked) return toast('请先确认授权'); const result = await send({ type: 'XVM_LIBRARY_MUTATE', payload: { action: 'set_cloud_backup', enabled: true } }); toast(result.ok ? '云备份已开启并完成首轮同步' : errorText(result.error)); if (result.ok) refreshStatus(); } });
    openDialog({ eyebrow: 'PRO · CLOUD', title: '管理云备份', copy: '可立即上传、恢复、关闭自动备份，或永久删除云端备份。', body: '<div class="row-actions"><button type="button" data-cloud-action="push">立即上传</button><button type="button" data-cloud-action="pull">从云端恢复</button><button type="button" data-cloud-action="disable">关闭自动备份</button><button type="button" class="danger" data-cloud-action="delete">永久删除云端备份</button></div>', confirm: '完成', onConfirm: () => {} });
    $('#dialog-body').onclick = async (event) => { const action = event.target.closest('[data-cloud-action]')?.dataset.cloudAction; if (!action) return; if (action === 'push' || action === 'pull') { const result = await send({ type: action === 'push' ? 'XVM_LIBRARY_CLOUD_PUSH' : 'XVM_LIBRARY_CLOUD_PULL' }); toast(result.ok ? (action === 'push' ? '云端上传完成' : `已恢复 ${result.applied || 0} 项`) : errorText(result.error)); } if (action === 'disable') { const result = await send({ type: 'XVM_LIBRARY_MUTATE', payload: { action: 'set_cloud_backup', enabled: false } }); toast(result.ok ? '已关闭自动备份，本地数据不受影响' : errorText(result.error)); } if (action === 'delete' && confirm('确认永久删除所有云端备份？本地数据不会删除。')) { const result = await send({ type: 'XVM_LIBRARY_CLOUD_DELETE' }); toast(result.ok ? '云端备份已永久删除' : errorText(result.error)); } $('#dialog').close(); refreshStatus(); };
  };
  $('#save-filter').onclick = saveFilter; $('#more').onclick = showArchive;
  $('#saved-filters').onclick = async (event) => { const applyId = event.target.closest('[data-apply-filter]')?.dataset.applyFilter; const deleteId = event.target.closest('[data-delete-filter]')?.dataset.deleteFilter; if (applyId) await applyFilter(state.savedFilters.find((item) => item.id === applyId)?.query); if (deleteId) { const result = await send({ type: 'XVM_LIBRARY_MUTATE', payload: { action: 'delete_filter', id: deleteId } }); toast(result.ok ? '筛选已删除' : errorText(result.error)); if (result.ok) refreshSavedFilters(); } };
  $('#next').onclick = () => { if (!state.nextCursor) return; state.cursorStack.push(state.cursor); state.cursor = state.nextCursor; query(); }; $('#prev').onclick = () => { state.cursor = state.cursorStack.pop() ?? null; query(); };
  $('#relation-search').oninput = (event) => { state.relationSearch = event.target.value; renderRelationships(); }; $('#unfollow-search').oninput = (event) => { state.unfollowSearch = event.target.value; renderRelationships(); };
  $$('#relations-screen [data-relation-filter]').forEach((button) => button.onclick = () => { state.relationFilter = button.dataset.relationFilter; $$('#relations-screen [data-relation-filter]').forEach((item) => item.classList.toggle('active', item === button)); renderRelationships(); });
  $$('#unfollow-screen [data-unfollow-filter]').forEach((button) => button.onclick = () => { state.unfollowFilter = button.dataset.unfollowFilter; $$('#unfollow-screen [data-unfollow-filter]').forEach((item) => item.classList.toggle('active', item === button)); renderRelationships(); });
  $('#relationship-cloud').onclick = async () => { if (!isPro()) return toast('关系云同步需要 Pro 会员'); const enabled = !state.relations.cloudSync; const result = await send({ type: 'XVM_LIBRARY_MUTATE', payload: { action: 'set_relationship_cloud', enabled } }); toast(result.ok ? (enabled ? '关系云同步已开启' : '关系云同步已关闭') : errorText(result.error)); if (result.ok) refreshRelationships(); };
  $('#relationship-sync').onclick = async () => { const result = await send({ type: 'XVM_LIBRARY_RELATIONSHIPS_SYNC' }); toast(result.ok ? `关系历史同步完成，共 ${result.events || 0} 条` : errorText(result.error)); if (result.ok) refreshRelationships(); };
  $$('[data-open-x]').forEach((button) => button.onclick = () => window.open(`https://x.com/${button.dataset.openX}`, '_blank', 'noopener'));
  Promise.allSettled([refreshSiteSession(), refreshStatus()]).then(() => showSection(new URLSearchParams(location.search).get('section') || 'library'));
})();
