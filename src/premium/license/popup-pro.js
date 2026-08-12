// === XVM popup Pro tab (popup context) — Waffo subscription + Better Auth ===
//
// Renders the subscription hub in the extension popup. The Worker is the
// only authority for subscription access; the popup keeps only the auth token
// in storage and fetches the current plan whenever it opens or changes.
//
// Auth flow:
//   1. User clicks "Sign in with Google" → the popup opens the official
//      website's Google login flow in a new tab.
//   2. After OAuth, the website mints a short-lived, single-use handoff code
//      and sends it to the installed extension.
//   3. The background worker exchanges that code for a bearer token and this
//      popup re-renders when chrome.storage changes.
//
// Subscription flow:
//   1. Signed-in user picks monthly ($5.99) or annual ($57.50) billing → POST
//      /api/checkout/start → get a Waffo checkoutUrl → open it.
//   2. After payment, the Waffo webhook updates D1; we poll
//      /api/subscription/status on popup open.

(() => {
  const AUTH_BACKEND_URL = 'https://x.jieyiai.dev';
  const PRODUCT_SITE_URL = 'https://x.jieyiai.dev';
  const WAFFO_PORTAL_URL = 'https://pancake.waffo.ai/consumer/portal';

  const TL = globalThis.__xvmTierLogic;
  if (!TL) {
    console.error('[xvm] tier-logic.js not loaded before popup-pro.js — popup.html script order broken');
    return;
  }
  const { subscriptionStatusFrom } = TL;
  const isCommunityDev = globalThis.__xvmIsCommunityDevBuild === true;

  const SESSION_KEY = 'xvm_session_v1';
  const SUBSCRIPTION_KEY = 'xvm_subscription_v1';
  let currentSubscription = null;

  const PLANS = [
    { id: 'monthly', price: '$5.99', periodKey: 'proPlanMonthlyPeriod', noteKey: 'proPlanMonthlyNote' },
    { id: 'yearly', price: '$57.50', periodKey: 'proPlanYearlyPeriod', noteKey: 'proPlanYearlyNote', recommended: true },
  ];

  function t(key, ...subs) {
    try {
      const v = chrome?.i18n?.getMessage?.(key, subs.length ? subs.map(String) : undefined);
      if (v) return v;
    } catch (_) {}
    return key;
  }

  // ─── chrome.storage promises ────────────────────────────────────────
  function storageGet(key, fallback) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(key, (o) => resolve(o?.[key] ?? fallback)); }
      catch (_) { resolve(fallback); }
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set(obj, resolve); }
      catch (_) { resolve(); }
    });
  }
  function storageRemove(key) {
    return new Promise((resolve) => {
      try { chrome.storage.local.remove(key, resolve); }
      catch (_) { resolve(); }
    });
  }

  // ─── Tier resolver ─────────────────────────────────────────────────
  async function resolveTier() {
    if (isCommunityDev) {
      return { tier: 'max', daysLeft: 0, source: 'community-dev', record: null };
    }
    const status = subscriptionStatusFrom(currentSubscription, Date.now());
    return { ...status, daysLeft: 0, record: currentSubscription };
  }

  function signInWithGoogle() {
    // Extension and website cookies are deliberately isolated by Chrome.
    // Let the first-party website own OAuth, then use its safe handoff flow
    // to place the resulting bearer session into this extension.
    const loginUrl = new URL(PRODUCT_SITE_URL);
    loginUrl.searchParams.set('extensionLogin', '1');
    loginUrl.hash = 'pricing';
    window.open(loginUrl.toString(), '_blank', 'noopener');
  }

  async function signOut() {
    // Best-effort: tell Better Auth to revoke the session, then clear local.
    const session = await storageGet(SESSION_KEY, null);
    if (session?.token) {
      try {
        await fetch(`${AUTH_BACKEND_URL}/api/auth/sign-out`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.token}` },
        });
      } catch (_) {}
    }
    await Promise.all([storageRemove(SESSION_KEY), storageRemove(SUBSCRIPTION_KEY)]);
    refresh();
  }

  // ─── Subscription: checkout + status poll ───────────────────────────
  async function startCheckout(interval) {
    const session = await storageGet(SESSION_KEY, null);
    if (!session?.token) return { ok: false, error: 'not_signed_in' };
    try {
      const res = await fetch(`${AUTH_BACKEND_URL}/api/checkout/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ interval }),
      });
      const data = await res.json();
      if (!data?.ok) return { ok: false, error: data?.error || 'checkout_failed' };
      return { ok: true, checkoutUrl: data.checkoutUrl };
    } catch (e) {
      return { ok: false, error: 'network', message: String(e?.message || e) };
    }
  }

  async function refreshSubscriptionStatus() {
    const session = await storageGet(SESSION_KEY, null);
    if (!session?.token) {
      currentSubscription = null;
      return { ok: true, record: null };
    }
    const cached = await storageGet(SUBSCRIPTION_KEY, null);
    if (cached?.plan) {
      currentSubscription = {
        userId: session.userId,
        email: session.email,
        plan: cached.plan,
        status: cached.status,
        currentPeriodEnd: cached.expiresAt,
      };
    }
    try {
      const res = await fetch(`${AUTH_BACKEND_URL}/api/subscription/status`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      if (res.status === 401 || res.status === 403) {
        await Promise.all([storageRemove(SESSION_KEY), storageRemove(SUBSCRIPTION_KEY)]);
        currentSubscription = null;
        return { ok: false, error: 'auth_expired' };
      }
      if (!res.ok) return { ok: false, error: 'status_failed' };
      const data = await res.json();
      if (!data?.ok) return { ok: false, error: data?.error || 'status_failed' };
      currentSubscription = {
        userId: session.userId,
        email: session.email,
        plan: data.plan,
        status: data.status,
        currentPeriodEnd: data.expiresAt,
      };
      await storageSet({ [SUBSCRIPTION_KEY]: { ...data, checkedAt: Date.now() } });
      return { ok: true, record: currentSubscription };
    } catch (_) {
      // Keep the cached membership status during a network outage.
      return { ok: false, error: 'network' };
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────
  function appendProScope(container) {
    const scope = document.createElement('div');
    scope.className = 'pro-scope';

    const paid = document.createElement('div');
    paid.className = 'pro-scope-block';
    const paidTitle = document.createElement('div');
    paidTitle.className = 'pro-scope-title';
    paidTitle.textContent = t('proScopeTitle');
    const paidBody = document.createElement('p');
    paidBody.textContent = t('proScopeBody');
    paid.append(paidTitle, paidBody);

    const free = document.createElement('div');
    free.className = 'pro-scope-block free';
    const freeTitle = document.createElement('div');
    freeTitle.className = 'pro-scope-title';
    freeTitle.textContent = t('proFreeTitle');
    const freeBody = document.createElement('p');
    freeBody.textContent = t('proFreeBody');
    free.append(freeTitle, freeBody);

    scope.append(paid, free);
    container.appendChild(scope);
  }

  function tierLabel(tier) {
    if (isCommunityDev) return 'DEV';
    return tier === 'pro' ? t('chipTierPro')
      : t('chipTierFree');
  }

  function render(container, info) {
    const tier = info.tier;
    const days = info.daysLeft;
    container.dataset.tier = tier;
    document.body.dataset.tier = tier;
    document.body.dataset.buildChannel = globalThis.__xvmBuildChannel || 'store';
    window.__xvmProDays = null;
    window.dispatchEvent(new CustomEvent('xvm-pro-days', { detail: { days, tier } }));
    container.innerHTML = '';

    if (isCommunityDev) {
      const dev = document.createElement('div');
      dev.className = 'community-dev-badge';
      dev.textContent = t('communityDevBadge');
      container.appendChild(dev);
    }

    // Subscription status
    const kicker = document.createElement('div');
    kicker.className = 'subscription-kicker';
    kicker.textContent = t(isCommunityDev ? 'communityDevKicker' : 'subscriptionKicker');
    container.appendChild(kicker);

    const tierEl = document.createElement('div');
    tierEl.className = 'tier-big';
    tierEl.textContent = tierLabel(tier);
    container.appendChild(tierEl);

    // Tier subtitle
    const sub = document.createElement('div');
    sub.className = 'tier-sub';
    if (isCommunityDev) {
      sub.textContent = t('communityDevSub');
    } else if (tier === 'pro') {
      sub.textContent = t('heroProActive');
    } else {
      sub.textContent = t('heroFreeTagline');
    }
    container.appendChild(sub);

    if (!isCommunityDev) {
      appendProScope(container);
    }

    if (isCommunityDev) return;

    // ─── Action area ────────────────────────────────────────────────
    const isPaid = tier === 'pro';

    if (!isPaid) {
      // Not subscribed: show Google sign-in + plan cards.
      renderSignInAndPlans(container);
    } else {
      // Subscribed: show status + manage.
      renderSubscribed(container, info);
    }
  }

  function renderSignInAndPlans(container) {
    // Google sign-in button
    const signInRow = document.createElement('div');
    signInRow.className = 'pro-cta-row';
    const signInBtn = document.createElement('button');
    signInBtn.type = 'button';
    signInBtn.className = 'pro-cta';
    signInBtn.innerHTML = `<svg><use href="#icon-sparkles"/></svg> <span></span>`;
    signInBtn.querySelector('span').textContent = t('proSignInGoogle');
    signInBtn.addEventListener('click', signInWithGoogle);
    signInRow.appendChild(signInBtn);
    container.appendChild(signInRow);

    // Plan cards (only meaningful once signed in, but visible to entice).
    const plansWrap = document.createElement('div');
    plansWrap.className = 'pro-plans';
    for (const plan of PLANS) {
      const card = document.createElement('div');
      card.className = `pro-plan-card plan-${plan.id}${plan.recommended ? ' is-recommended' : ''}`;
      card.innerHTML = `
        <div class="plan-name">${t('proPlanName')}</div>
        <div class="plan-note">${t(plan.noteKey)}</div>
        <div class="plan-price">${plan.price}<span class="plan-period">${t(plan.periodKey)}</span></div>
        <button type="button" class="plan-btn">${t('proPlanChoose')}</button>
        ${plan.recommended ? `<span class="plan-recommended">${t('proPlanRecommended')}</span>` : ''}
      `;
      card.querySelector('.plan-btn').addEventListener('click', async () => {
        const session = await storageGet(SESSION_KEY, null);
        if (!session?.token) {
          signInWithGoogle();
          return;
        }
        const res = await startCheckout(plan.id);
        if (res.ok && res.checkoutUrl) {
          window.open(res.checkoutUrl, '_blank');
        }
      });
      plansWrap.appendChild(card);
    }
    container.appendChild(plansWrap);

    // Website link
    const row = document.createElement('div');
    row.className = 'pro-cta-row';
    const site = document.createElement('a');
    site.className = 'pro-cta secondary';
    site.href = PRODUCT_SITE_URL; site.target = '_blank'; site.rel = 'noopener';
    site.textContent = t('proWebsiteLink');
    row.appendChild(site);
    container.appendChild(row);
  }

  function renderSubscribed(container, info) {
    const row = document.createElement('div');
    row.className = 'pro-cta-row';

    // Manage subscription (Waffo customer portal)
    const manage = document.createElement('a');
    manage.className = 'pro-cta secondary';
    manage.href = WAFFO_PORTAL_URL;
    manage.target = '_blank'; manage.rel = 'noopener';
    manage.textContent = t('proManageBtn');
    row.appendChild(manage);

    // Sign out
    const signOutBtn = document.createElement('button');
    signOutBtn.type = 'button';
    signOutBtn.className = 'pro-cta secondary';
    signOutBtn.textContent = t('proSignOut');
    signOutBtn.addEventListener('click', signOut);
    row.appendChild(signOutBtn);
    container.appendChild(row);

    // Subscription meta
    const session = info.record || {};
    const meta = document.createElement('div');
    meta.className = 'pro-meta';
    const periodEnd = session.currentPeriodEnd;
    meta.innerHTML = `
      <div class="row"><span></span><code>${tierLabel(info.tier)}</code></div>
      ${session.email ? `<div class="row"><span></span><span>${session.email}</span></div>` : ''}
      ${periodEnd ? `<div class="row"><span></span><span>${new Date(periodEnd).toLocaleDateString()}</span></div>` : ''}
    `;
    const labels = ['proPlanField'];
    if (session.email) labels.push('proEmailField');
    if (periodEnd) labels.push('proRenewsField');
    meta.querySelectorAll('.row > span:first-child').forEach((el, i) => {
      el.textContent = t(labels[i] || '');
    });
    container.appendChild(meta);
  }

  async function refresh() {
    const container = document.getElementById('xvm-pro-section');
    if (!container) return;
    await refreshSubscriptionStatus();
    const info = await resolveTier();
    render(container, info);
  }

  // Re-render on storage changes (auth token stored, subscription updated).
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (SESSION_KEY in changes || SUBSCRIPTION_KEY in changes) refresh();
    });
  } catch (_) {}

  refresh();

  window.__xvmProPopup = { refresh, resolveTier, signInWithGoogle, signOut, startCheckout };
})();
