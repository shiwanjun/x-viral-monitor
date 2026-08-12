// Local preview fallback only. The packaged extension always uses Chrome
// storage and its real signed-in account; this lets the dashboard be reviewed
// over localhost without exposing or fabricating production credentials.
if (!globalThis.chrome?.storage?.local) {
  const demoStorage = {
    xvm_session_v1: { token: 'preview-token', userId: 'preview', email: 'you@example.com' },
    followRadarCloudSync: true,
    followRadarV1: { events: [
      { id: 'unfollowed_me:lin:1723395600000', h: 'lin', n: 'Lin', type: 'unfollowed_me', ts: 1723395600000, fc: 48200, fd: 590 },
      { id: 'i_unfollowed:studio:1723309200000', h: 'studio', n: 'Studio Notes', type: 'i_unfollowed', ts: 1723309200000, fc: 12800, fd: 930 },
      { id: 'unfollowed_me:orbit:1723222800000', h: 'orbit', n: 'Orbit', type: 'unfollowed_me', ts: 1723222800000, fc: 8600, fd: 712 },
    ] },
  };
  const read = (keys) => {
    const requested = Array.isArray(keys) ? keys : Object.keys(keys || {});
    return Object.fromEntries(requested.map((key) => [key, demoStorage[key] ?? (keys?.[key] ?? undefined)]));
  };
  globalThis.chrome = {
    storage: {
      local: { get: (keys, done) => done(read(keys)), set: (items, done) => { Object.assign(demoStorage, items); done?.(); }, remove: (key, done) => { delete demoStorage[key]; done?.(); } },
      onChanged: { addListener: () => {} },
    },
    tabs: { create: () => {} },
  };
}

(() => {
  const state = {
    rows: [], folders: [], folder: 'all', query: '', metric: 'all', mediaFilter: 'all',
    view: 'bookmarks', radarEvents: [], radarQuery: '', radarFilter: 'all', radarVisible: 50,
    session: null, subscription: null, cloudSync: false,
  };
  const API_URL = 'https://x.jieyiai.dev';
  const RADAR_STORAGE_KEY = 'followRadarV1';
  const RADAR_SYNC_KEY = 'followRadarCloudSync';
  const $ = (selector) => document.querySelector(selector);
  const storageGet = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const compact = (value) => {
    const number = Number(value || 0);
    return number >= 1e6 ? `${(number / 1e6).toFixed(1)}M` : number >= 1e3 ? `${(number / 1e3).toFixed(1)}K` : number ? String(number) : '—';
  };
  const escape = (value) => String(value || '').replace(/[&<>'"]/g, (match) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[match]);
  const isMember = () => ['pro', 'max'].includes(state.subscription?.tier || '');
  const eventId = (event) => String(event.id || `${event.type || 'unknown'}:${event.h || ''}:${event.ts || 0}`);
  const formatDate = (value) => value ? new Date(value).toLocaleString() : '—';
  const formatCount = (value) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString();
  const rate = (event) => Number(event.fc) > 0 && Number.isFinite(Number(event.fd)) ? `${(Number(event.fd) / Number(event.fc)).toFixed(1)}x` : '—';

  async function authedFetch(path, options = {}) {
    if (!state.session?.token) throw new Error('not_signed_in');
    return fetch(`${API_URL}${path}`, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${state.session.token}` } });
  }

  async function refreshSubscription() {
    if (state.session?.token === 'preview-token') {
      state.subscription = { tier: 'pro', plan: 'pro', status: 'active', expiresAt: Date.now() + 22 * 24 * 60 * 60 * 1000 };
      return;
    }
    if (!state.session?.token) { state.subscription = null; return; }
    try {
      const response = await authedFetch('/api/subscription/status');
      if (response.status === 401 || response.status === 403) {
        await new Promise((resolve) => chrome.storage.local.remove(['xvm_session_v1', 'xvm_subscription_v1'], resolve));
        state.session = null;
        state.subscription = null;
        return;
      }
      if (!response.ok) throw new Error('subscription_unavailable');
      const data = await response.json();
      if (!data?.ok) throw new Error('subscription_unavailable');
      state.subscription = data;
      await new Promise((resolve) => chrome.storage.local.set({ xvm_subscription_v1: { ...data, checkedAt: Date.now() } }, resolve));
    } catch (_) {
      // A transient failure must not downgrade an otherwise valid cached plan.
    }
  }

  async function syncSession() {
    if (!state.session?.token || state.session.token === 'preview-token') return;
    try {
      const response = await authedFetch('/api/auth/get-session');
      if (response.status === 401 || response.status === 403) {
        await new Promise((resolve) => chrome.storage.local.remove(['xvm_session_v1', 'xvm_subscription_v1'], resolve));
        state.session = null;
        state.subscription = null;
        return;
      }
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload?.user?.id) return;
      state.session = { ...state.session, userId: payload.user.id, email: payload.user.email || state.session.email, name: payload.user.name || state.session.name };
      await new Promise((resolve) => chrome.storage.local.set({ xvm_session_v1: state.session }, resolve));
    } catch (_) {
      // Keep the last verified identity while offline.
    }
  }

  function tweetFromEntry(entry, folderId, folderName) {
    const result = entry?.content?.itemContent?.tweet_results?.result || {};
    const tweet = result?.tweet || result?.legacy || result;
    const legacy = tweet?.legacy || result?.legacy || {};
    const user = result?.core?.user_results?.result || tweet?.core?.user_results?.result || {};
    const userLegacy = user?.legacy || {};
    const media = legacy?.extended_entities?.media || legacy?.entities?.media || [];
    return {
      id: result?.rest_id || tweet?.rest_id || entry?.entryId || `${folderId}-${Math.random()}`,
      folderId, folderName,
      name: userLegacy.name || 'X 用户',
      handle: userLegacy.screen_name ? `@${userLegacy.screen_name}` : '@x_user',
      avatar: userLegacy.profile_image_url_https || '',
      text: legacy.full_text || legacy.text || '这条书签的内容正在等待同步。',
      views: Number(result?.views?.count || legacy?.view_count || 0),
      engagement: Number(legacy.favorite_count || 0) + Number(legacy.retweet_count || 0) + Number(legacy.reply_count || 0),
      media: media.map((item) => item.media_url_https || item.media_url).filter(Boolean).slice(0, 3),
    };
  }

  function renderFolders() {
    const nav = $('#folder-nav');
    nav.innerHTML = '';
    const addItem = (folder) => {
      const item = document.importNode($('#folder-template').content, true).querySelector('button');
      item.dataset.folder = folder.id;
      item.querySelector('.folder-name').textContent = folder.name;
      item.querySelector('.folder-size').textContent = state.rows.filter((row) => folder.id === 'all' || row.folderId === folder.id).length;
      item.classList.toggle('active', folder.id === state.folder);
      nav.append(item);
    };
    addItem({ id: 'all', name: '全部书签' });
    state.folders.forEach(addItem);
  }

  function activeRows() {
    const query = state.query.trim().toLocaleLowerCase();
    let rows = state.rows.filter((row) => {
      const matchesFolder = state.folder === 'all' || row.folderId === state.folder;
      const matchesQuery = !query || `${row.name} ${row.handle} ${row.text}`.toLocaleLowerCase().includes(query);
      const matchesMedia = state.mediaFilter === 'all'
        || (state.mediaFilter === 'media' ? row.media.length > 0 : row.media.length === 0);
      return matchesFolder && matchesQuery && matchesMedia;
    });
    if (state.metric === 'authors') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
    if (state.metric === 'media') rows = [...rows].sort((a, b) => b.media.length - a.media.length || b.views - a.views);
    return rows;
  }

  function renderRows() {
    const rows = activeRows();
    const body = $('#bookmark-body');
    body.innerHTML = rows.map((row, index) => `<tr><td class="check"><input class="row-select" type="checkbox" aria-label="选择 ${escape(row.name)} 的书签"></td><td>${index + 1}</td><td><div class="author">${row.avatar ? `<img src="${escape(row.avatar)}" alt="${escape(row.name)} 的头像">` : `<span class="avatar-fallback">${escape(row.name[0])}</span>`}<div><div class="author-name">${escape(row.name)}</div><div class="author-handle">${escape(row.handle)}</div></div></div></td><td><span class="folder-tag">${escape(row.folderName)}</span></td><td><div class="tweet-copy">${escape(row.text)}</div></td><td>${row.media.length ? `<div class="media">${row.media.map((url) => `<img src="${escape(url)}" alt="${escape(row.name)} 推文中的媒体">`).join('')}</div>` : '<span class="media-none">—</span>'}</td><td class="num">${compact(row.views)}</td><td class="num">${compact(row.engagement)}</td></tr>`).join('');
    $('#empty-state').hidden = rows.length > 0;
    $('#bookmark-table').classList.toggle('is-hidden', rows.length === 0);
    $('#bookmark-count').textContent = state.rows.length;
    $('#author-count').textContent = new Set(state.rows.map((row) => row.handle)).size;
    $('#media-count').textContent = state.rows.filter((row) => row.media.length).length;
    $('#table-summary').textContent = `已显示 ${rows.length} / ${state.rows.length} 条书签`;
    $('#select-all').checked = false;
  }

  function render() { renderFolders(); renderRows(); }

  function renderView() {
    const configuration = {
      bookmarks: ['本地优先', '书签库'],
      radar: ['会员洞察', '取关历史'],
      account: ['账户中心', '会员与同步'],
      settings: ['扩展控制', '调整 X-Tools'],
    }[state.view] || ['X-Tools', '工作台'];
    $('#view-eyebrow').textContent = configuration[0];
    $('#view-title').textContent = configuration[1];
    document.querySelectorAll('.workspace-view').forEach((view) => {
      const active = view.id === `${state.view}-workspace`;
      view.hidden = !active;
      view.classList.toggle('is-active', active);
    });
    document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
    const bookmarkOnly = state.view === 'bookmarks';
    $('.tabs').hidden = !bookmarkOnly;
    $('.search').hidden = !bookmarkOnly;
  }

  function renderRadar() {
    const all = [...state.radarEvents].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
    const byThem = all.filter((event) => event.type === 'unfollowed_me');
    const byMe = all.filter((event) => event.type === 'i_unfollowed');
    $('#nav-radar-count').textContent = all.length > 999 ? '999+' : String(all.length);
    $('#radar-event-total').textContent = String(all.length);
    $('#radar-their-total').textContent = String(byThem.length);
    $('#radar-my-total').textContent = String(byMe.length);
    $('#radar-sync-label').textContent = state.cloudSync ? '已开启' : '未开启';
    $('#radar-sync-detail').textContent = state.cloudSync ? '会员数据会按需加密传输' : '数据默认只留在此浏览器';

    const gate = $('#radar-member-gate');
    gate.hidden = isMember();
    if (!isMember()) {
      gate.innerHTML = '<h3>解锁完整取关历史</h3><p>免费版继续在本地积累关系数据。登录并开通会员后，可在此查看历史、筛选记录并启用可选云端同步。</p><button type="button" class="button" data-action="open-membership">登录或开通会员</button>';
    }
    $('#radar-history-panel').hidden = !isMember();
    if (!isMember()) return;

    const query = state.radarQuery.trim().toLowerCase();
    const filtered = all.filter((event) => {
      const direction = state.radarFilter === 'all' || event.type === state.radarFilter;
      const matches = !query || `${event.h || ''} ${event.n || ''}`.toLowerCase().includes(query);
      return direction && matches;
    });
    const page = filtered.slice(0, state.radarVisible);
    $('#radar-history-list').innerHTML = page.length ? page.map((event) => {
      const mine = event.type === 'i_unfollowed';
      const label = mine ? '你取关了 TA' : 'TA 取关了你';
      return `<article class="history-row"><div class="history-person"><strong>${escape(event.n || `@${event.h || '未知账号'}`)}</strong><span>@${escape(event.h || '')}</span></div><span class="history-kind${mine ? ' mine' : ''}">${label}</span><div class="history-meta"><span>${formatDate(event.ts)}</span><span>粉丝 ${formatCount(event.fc)}</span><span>关注 ${formatCount(event.fd)}</span><span>关注率 ${rate(event)}</span></div><button type="button" class="button secondary" data-open-handle="${escape(event.h || '')}">在 X 查看</button></article>`;
    }).join('') : '<div class="empty-history">还没有可显示的取关记录。请在 X 中扫描关注和粉丝列表，差异会保存在本机并显示在这里。</div>';
    const more = $('#radar-show-more');
    more.hidden = page.length >= filtered.length;
    more.textContent = `显示更多（剩余 ${filtered.length - page.length} 条）`;
  }

  function renderAccount() {
    const email = state.session?.email || '尚未登录';
    const member = isMember();
    const tier = member ? '会员已生效' : state.session ? '免费账户' : '未登录';
    const renews = state.subscription?.expiresAt ? new Date(state.subscription.expiresAt).toLocaleDateString() : '—';
    $('#account-top-action').innerHTML = member
      ? '<button type="button" class="button secondary" data-action="manage-membership">管理订阅</button>'
      : '<button type="button" class="button primary" data-action="open-membership">登录或开通会员</button>';
    $('#account-card').innerHTML = `<div class="account-state"><span class="state-dot"></span>${tier}</div><h3>${escape(email)}</h3><p>${member ? '会员已解锁取关历史、筛选与可选跨设备同步。' : '登录后可同步订阅状态；本机收集的数据始终保留在当前浏览器。'}</p><div class="account-rows"><div class="account-row"><span>订阅状态</span><b>${member ? 'Membership' : 'Free'}</b></div><div class="account-row"><span>续费日期</span><b>${renews}</b></div></div><div class="account-actions"><button class="button secondary" type="button" data-action="sign-out" ${state.session ? '' : 'hidden'}>退出登录</button></div>`;
    $('#sync-card').innerHTML = `<div class="account-state" style="color:${state.cloudSync ? 'var(--green)' : 'var(--muted)'}"><span class="state-dot"></span>${state.cloudSync ? '云端同步已开启' : '云端同步未开启'}</div><h3>取关历史同步</h3><p>只同步账号 handle、公开关注/粉丝数和发现时间。不会同步 X Cookie、登录凭证或原始页面内容。</p><div class="account-rows"><div class="account-row"><span>本机记录</span><b>${state.radarEvents.length} 条</b></div><div class="account-row"><span>保留规则</span><b>${member ? '会员完整保留' : '本机保留'}</b></div></div><div class="account-actions"><button class="button primary" type="button" data-action="toggle-sync" ${member ? '' : 'disabled'}>${state.cloudSync ? '关闭同步' : '开启同步'}</button><button class="button secondary" type="button" data-action="sync-radar" ${member ? '' : 'disabled'}>立即同步</button></div>`;
    $('#privacy-card').innerHTML = '<h3>数据与隐私</h3><p>扫描由你已登录的 X 浏览器会话完成。取关事件默认仅保存在本机；你可以随时清除本地数据，或删除云端同步历史。</p><div class="account-actions"><button class="button secondary" type="button" data-action="clear-local">清除本地历史</button><button class="button secondary" type="button" data-action="delete-cloud" disabled>删除云端历史</button></div>';
    $('#activity-card').innerHTML = `<h3>下一步</h3><p>${state.radarEvents.length ? '打开取关历史，筛选并查看最近的关系变化。' : '先在 X 关注页或粉丝页完成一次扫描，工作台会自动整理关系变化。'}</p><div class="account-actions"><button class="button primary" type="button" data-action="go-radar">查看取关历史</button><button class="button secondary" type="button" data-action="open-x-following">打开 X 扫描</button></div>`;
  }

  function renderWorkspace() { render(); renderRadar(); renderAccount(); renderView(); }

  async function hydrate() {
    const {
      xvm_session_v1: session,
      xvm_subscription_v1: cachedSubscription,
      bookmarkTimelineCache: cache = {},
      bookmarkFoldersCache: folderCache = {},
      [RADAR_STORAGE_KEY]: radar = {},
      [RADAR_SYNC_KEY]: cloudSync = false,
    } = await storageGet(['xvm_session_v1', 'xvm_subscription_v1', 'bookmarkTimelineCache', 'bookmarkFoldersCache', RADAR_STORAGE_KEY, RADAR_SYNC_KEY]);
    state.session = session || null;
    state.subscription = cachedSubscription || null;
    await syncSession();
    state.cloudSync = cloudSync === true;
    state.radarEvents = Array.isArray(radar?.events) ? radar.events : [];
    await refreshSubscription();
    const foldersById = new Map((Array.isArray(folderCache?.folders) ? folderCache.folders : []).map((folder) => [String(folder.id), String(folder.name)]));
    const records = cache?.folders || {};
    state.folders = Object.keys(records).map((id) => ({ id, name: foldersById.get(id) || `未分类 ${id.slice(-4)}` }));
    state.rows = state.folders.flatMap((folder) => (records[folder.id]?.entries || []).map((entry) => tweetFromEntry(entry, folder.id, folder.name)));
    if (state.folder !== 'all' && !state.folders.some((folder) => folder.id === state.folder)) state.folder = 'all';
    const refreshedAt = Math.max(0, ...Object.values(records).map((record) => Number(record?.refreshedAt) || 0));
    $('#folder-sync-state').textContent = refreshedAt ? `更新于 ${new Date(refreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '等待同步';
    const email = session?.email || '';
    const profile = $('#profile');
    profile.querySelector('strong').textContent = email || '未登录';
    profile.querySelector('small').textContent = email ? '已登录 · 本地书签' : '请从扩展中登录';
    profile.querySelector('.avatar').textContent = (email[0] || 'X').toUpperCase();
    renderWorkspace();
  }

  function openBookmarks() { chrome.tabs.create({ url: 'https://x.com/i/bookmarks' }); }
  function openX(url) { chrome.tabs.create({ url }); }

  async function persistRadarEvents() {
    const current = (await storageGet([RADAR_STORAGE_KEY]))[RADAR_STORAGE_KEY] || {};
    await new Promise((resolve) => chrome.storage.local.set({ [RADAR_STORAGE_KEY]: { ...current, events: state.radarEvents } }, resolve));
  }

  async function syncRadar() {
    if (!isMember()) return;
    const response = await authedFetch('/api/follow-radar/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: state.radarEvents }),
    });
    if (!response.ok) throw new Error('sync_failed');
    const remote = await authedFetch('/api/follow-radar/events?limit=1000');
    if (!remote.ok) throw new Error('pull_failed');
    const payload = await remote.json();
    const merged = new Map(state.radarEvents.map((event) => [eventId(event), event]));
    (payload.events || []).forEach((event) => {
      const normalized = { id: event.eventId, h: event.handle, n: event.displayName, type: event.eventType, ts: event.occurredAt, fc: event.followersCount, fd: event.followingCount };
      merged.set(eventId(normalized), { ...merged.get(eventId(normalized)), ...normalized });
    });
    state.radarEvents = [...merged.values()].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, 1000);
    await persistRadarEvents();
    renderWorkspace();
  }

  async function setCloudSync(enabled) {
    if (!isMember()) return;
    state.cloudSync = enabled;
    await new Promise((resolve) => chrome.storage.local.set({ [RADAR_SYNC_KEY]: enabled }, resolve));
    if (enabled) await syncRadar();
    renderWorkspace();
  }

  async function handleAction(action) {
    try {
      if (action === 'open-x-following') return openX('https://x.com/following');
      if (action === 'open-x-home') return openX('https://x.com/home');
      if (action === 'open-membership') return openX('https://x.jieyiai.dev/#pricing');
      if (action === 'manage-membership') return openX('https://pancake.waffo.ai/consumer/portal');
      if (action === 'go-radar') { state.view = 'radar'; return renderWorkspace(); }
      if (action === 'sync-radar') return syncRadar();
      if (action === 'toggle-sync') return setCloudSync(!state.cloudSync);
      if (action === 'clear-local') {
        if (!confirm('清除本机保存的取关历史？云端记录不会删除。')) return;
        state.radarEvents = []; await persistRadarEvents(); return renderWorkspace();
      }
      if (action === 'sign-out') {
        if (state.session?.token) {
          try { await authedFetch('/api/auth/sign-out', { method: 'POST' }); } catch (_) {}
        }
        await new Promise((resolve) => chrome.storage.local.remove(['xvm_session_v1', 'xvm_subscription_v1'], resolve));
        return hydrate();
      }
      if (action === 'open-popup') return alert('请点击浏览器工具栏中的 X-Tools 图标，打开扩展设置。');
    } catch (_) { alert('操作暂时无法完成，请检查网络与会员登录状态后重试。'); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    hydrate();
    document.querySelector('.sidebar').addEventListener('click', (event) => {
      const button = event.target.closest('[data-view]');
      if (!button) return;
      state.view = button.dataset.view;
      renderWorkspace();
    });
    $('#search').addEventListener('input', (event) => { state.query = event.target.value; renderRows(); });
    $('#folder-nav').addEventListener('click', (event) => { const button = event.target.closest('[data-folder]'); if (!button) return; state.folder = button.dataset.folder; render(); });
    document.querySelectorAll('.metric-tab').forEach((button) => button.addEventListener('click', () => { state.metric = button.dataset.sort; document.querySelectorAll('.metric-tab').forEach((item) => item.classList.toggle('active', item === button)); renderRows(); }));
    $('#filter-button').addEventListener('click', () => { const bar = $('#filter-bar'); bar.hidden = !bar.hidden; $('#filter-button').setAttribute('aria-expanded', String(!bar.hidden)); });
    document.querySelectorAll('.filter-choice').forEach((button) => button.addEventListener('click', () => { state.mediaFilter = button.dataset.mediaFilter; document.querySelectorAll('.filter-choice').forEach((item) => item.classList.toggle('active', item === button)); renderRows(); }));
    document.querySelectorAll('[data-density]').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('[data-density]').forEach((item) => { const active = item === button; item.classList.toggle('selected', active); item.setAttribute('aria-pressed', String(active)); }); $('.table-wrap').classList.toggle('compact', button.dataset.density === 'compact'); }));
    $('#select-all').addEventListener('change', (event) => document.querySelectorAll('.row-select').forEach((input) => { input.checked = event.target.checked; }));
    $('#refresh-button').addEventListener('click', hydrate);
    $('#open-x').addEventListener('click', openBookmarks);
    $('#empty-open-x').addEventListener('click', openBookmarks);
    $('#radar-search').addEventListener('input', (event) => { state.radarQuery = event.target.value; state.radarVisible = 50; renderRadar(); });
    document.querySelector('.segmented').addEventListener('click', (event) => {
      const button = event.target.closest('[data-radar-filter]'); if (!button) return;
      state.radarFilter = button.dataset.radarFilter; state.radarVisible = 50;
      document.querySelectorAll('[data-radar-filter]').forEach((item) => item.classList.toggle('active', item === button)); renderRadar();
    });
    $('#radar-show-more').addEventListener('click', () => { state.radarVisible += 50; renderRadar(); });
    document.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action) handleAction(action);
      const handle = event.target.closest('[data-open-handle]')?.dataset.openHandle;
      if (handle) openX(`https://x.com/${handle}`);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.bookmarkTimelineCache || changes.bookmarkFoldersCache || changes.xvm_session_v1 || changes[RADAR_STORAGE_KEY] || changes[RADAR_SYNC_KEY]) hydrate();
    });
    document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search').focus(); } });
  });
})();
