/* Account dashboards: accounts are grouped by type (cash, wallets, banks, cards). Click one to see its
   balance, cash in / out, card limit and due date, a 6-month chart and the recent transactions. */
let adReady = false, adId = null, adLimit = 15, adDir = 'all', adFrom = '', adTo = '', adQ = '', adData = null, adTimer = null;
const AD_GROUPS = [['cash', 'Cash'], ['mfs', 'Mobile wallets (MFS)'], ['bank', 'Bank accounts'], ['card', 'Credit cards']];
const adSvg = p => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const AD_ICON = {
  cash: adSvg('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>'),
  mfs: adSvg('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'),
  bank: adSvg('<path d="M3 21h18M5 21V10M9 21V10M15 21V10M19 21V10M2 10l10-7 10 7z"/>'),
  card: adSvg('<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20"/>'),
};
const adDate = d => new Date(d + 'T00:00:00').toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'});

/* ----- the Accounts page, grouped by type ----- */
function adTile(a) {
  const html = accountCard(a).replace('<div class="goal-act">', `<div class="goal-act"><button type="button" class="primary" data-open="${a.id}">Open dashboard</button>`);
  return `<div class="acct-wrap" data-open-card="${a.id}" tabindex="0" role="button" aria-label="Open the dashboard for ${esc(a.name)}">${html}</div>`;
}
function adRenderGroups() {
  const act = accounts.filter(a => !a.archived);
  if (!act.length) return;                              // keep the "no accounts yet" message
  $('acct-list').innerHTML = AD_GROUPS.map(([t, title]) => {
    const list = act.filter(a => a.type === t); if (!list.length) return '';
    const total = list.reduce((s, a) => s + Number(a.balance), 0);
    return `<div class="grp"><div class="grp-head"><h3><span class="grp-ic">${AD_ICON[t]}</span>${title} <small>${list.length}</small></h3><span class="grp-total">${t === 'card' ? 'Owed ' + fmt(Math.max(0, -total)) : fmt(total)}</span></div><div class="acct-grid">${list.map(adTile).join('')}</div></div>`;
  }).join('');
}

/* ----- one account's dashboard ----- */
function adOpen(id) {
  adId = Number(id); adLimit = 15; adDir = 'all'; adFrom = adTo = adQ = '';
  $('ad-from').value = ''; $('ad-to').value = ''; $('ad-q').value = ''; document.querySelectorAll('#ad-chips [data-r]').forEach(b => b.classList.remove('on'));
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-acctdetail');
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === 'accounts'));
  document.querySelectorAll('#ad-filter button').forEach(b => b.classList.toggle('on', b.dataset.f === 'all'));
  $('page-title').textContent = 'Account dashboard'; $('ad-stats').innerHTML = ''; $('ad-recent').innerHTML = '';
  window.scrollTo({top: 0, behavior: 'smooth'}); adLoad();
}
async function adLoad() {
  try { adData = await api(`/api/accounts/${adId}/summary?${adQuery(adLimit)}`); adRender(); }
  catch (e) { $('ad-head').textContent = e.message; }
}
function adQuery(limit) {
  const p = new URLSearchParams(); if (limit) p.set('limit', limit);
  if (adFrom) p.set('from', adFrom); if (adTo) p.set('to', adTo); if (adQ) p.set('q', adQ); if (adDir !== 'all') p.set('dir', adDir);
  return p.toString();
}
const adActive = () => !!(adFrom || adTo || adQ || adDir !== 'all');
function adStat(cls, label, big, sub, extra) { return `<div class="stat ${cls || ''}"><span class="lbl">${label}</span><b class="big ${cls === 'in' ? 'in' : ''}">${big}</b><small>${sub || ''}</small>${extra || ''}</div>`; }
function adRender() {
  const d = adData, a = d.account, card = a.type === 'card', t = d.totals;
  const sub = [TYPE_NAME[a.type], a.provider, a.acct_no ? '••' + a.acct_no : ''].filter(Boolean).join(' · ');
  $('ad-head').innerHTML = `<span class="ad-ico">${AD_ICON[a.type] || ''}</span><div><h2>${esc(a.name)}${a.archived ? ' <span class="badge overdue">archived</span>' : ''}</h2><small>${esc(sub)}</small></div>`;
  const dot = k => `<i class="dot ${k}"></i>`, inLbl = 'Total cash in', outLbl = 'Total cash out';
  let html;
  if (card) {
    const lim = a.credit_limit, pct = d.utilization, over = pct != null && pct >= 80;
    const due = d.due ? `${adDate(d.due.date)}` : 'Not set', dueSub = d.due ? `${d.due.days_left === 0 ? 'Due today' : 'In ' + d.due.days_left + ' day' + (d.due.days_left > 1 ? 's' : '')} · ${d.owed > 0 ? 'amount owed ' + fmt(d.owed) : 'nothing to pay now'}` : 'Edit the card to add its payment due day';
    html = adStat('hero', 'Balance owed', fmt(d.owed), d.balance > 0 ? `Credit balance ${fmt(d.balance)}` : lim ? `${pct}% of your limit used` : 'No limit set', lim ? `<div class="mini-bar"><b style="width:${Math.min(100, pct)}%"></b></div>` : '')
      + adStat('', 'Credit limit', lim != null ? fmt(lim) : 'Not set', lim != null ? `Available: <b>${fmt(d.available)}</b>` : 'Edit the card to add its limit', lim ? `<div class="mini-bar ${over ? 'hi' : ''}"><b style="width:${Math.min(100, pct)}%"></b></div>` : '')
      + adStat('', 'Payment due', due, dueSub)
      + adStat('in', dot('in') + inLbl, fmt(t.in), `Payments and refunds · this month: +${fmt(t.in_month)}`)
      + adStat('', dot('out') + outLbl, fmt(t.out), `Spending and cash advances · this month: −${fmt(t.out_month)}`);
  } else {
    const net = t.in_month - t.out_month, ml = a.monthly_limit, notes = [];
    if (ml) notes.push(`Spending limit: ${fmt(d.spent_month)} of ${fmt(ml)} used this month`);
    if (a.min_balance != null) notes.push(`Warns below ${fmt(a.min_balance)}${d.balance < a.min_balance ? ' (it is below now)' : ''}`);
    html = adStat('hero', 'Balance', fmt(d.balance), a.reconciled_on ? `Last checked against the real balance: ${esc(a.reconciled_on)}` : 'Not checked against the real balance yet')
      + adStat('in', dot('in') + inLbl, fmt(t.in), `This month: +${fmt(t.in_month)}`)
      + adStat('', dot('out') + outLbl, fmt(t.out), `This month: −${fmt(t.out_month)}`)
      + adStat('', 'Net this month', `${net < 0 ? '−' : '+'}${fmt(Math.abs(net))}`, notes.join('<br>') || 'Cash in minus cash out', ml ? `<div class="mini-bar ${d.spent_month > ml ? 'hi' : ''}"><b style="width:${Math.min(100, d.spent_month / ml * 100)}%"></b></div>` : '');
  }
  $('ad-stats').className = 'ad-stats ' + (card ? 'is-card' : 'is-acct'); $('ad-stats').innerHTML = html;
  $('ad-chart').innerHTML = ovBars(d.monthly.map(m => ({ym: m.ym, income: m.in, spent: m.out})));
  adRenderCompare(); adRenderCats(); adRenderRecent();
}
const adMonth = k => { const [y, m] = k.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
const adPct = v => v === null || v === undefined ? '' : `${v > 0 ? '+' : ''}${v}%`;
function adRenderCompare() {
  const c = adData.compare, card = adData.account.type === 'card';
  $('ad-cmp-lbl').textContent = `${adMonth(c.cur_label)} vs ${adMonth(c.prev_label)}`;
  const row = (label, cur, prev, change, upGood) => {
    const delta = cur - prev, cls = delta === 0 ? '' : (delta > 0) === upGood ? 'good' : 'badc';
    return `<div class="cmp-row"><span>${label}</span><b>${fmt(cur)}</b><span class="prev">${fmt(prev)}</span><span class="chg ${cls}">${delta === 0 ? '–' : (delta > 0 ? '▲ ' : '▼ ') + (change === null ? (cur > 0 && prev === 0 ? 'new' : fmt(Math.abs(delta))) : Math.abs(change) + '%')}</span></div>`;
  };
  const movers = c.categories.length ? `<h4>Biggest changes in spending</h4>` + c.categories.map(m => { const d = m.change, cls = d === 0 ? '' : d > 0 ? 'badc' : 'good'; return `<div class="cmp-row small"><span>${esc(m.category)}</span><b>${fmt(m.cur)}</b><span class="prev">${fmt(m.prev)}</span><span class="chg ${cls}">${d === 0 ? '–' : (d > 0 ? '▲ ' : '▼ ') + fmt(Math.abs(d))}</span></div>`; }).join('') : '';
  $('ad-compare').innerHTML = `<div class="cmp"><div class="cmp-row head"><span></span><b>This month</b><span>Last month</span><span>Change</span></div>
    ${row('Cash in', c.cur.in, c.prev.in, c.change.in, true)}${row('Cash out', c.cur.out, c.prev.out, c.change.out, false)}${row('Net', c.cur.net, c.prev.net, null, true)}</div>${movers}`;
}
function adRenderCats() {
  const b = adData.breakdown, top = b.items.slice(0, 6), rest = b.items.slice(6), max = top.length ? top[0].total : 1;
  $('ad-cat-lbl').textContent = b.label === 'Selected dates' ? [adFrom && adDate(adFrom), adTo && adDate(adTo)].filter(Boolean).join(' to ') || 'Selected dates' : 'This month';
  if (rest.length) top.push({category: `Other (${rest.length})`, total: rest.reduce((s, x) => s + x.total, 0), count: rest.reduce((s, x) => s + x.count, 0), pct: rest.reduce((s, x) => s + x.pct, 0)});
  $('ad-cats').innerHTML = top.length ? `<div class="cats-list">${top.map(x => `<div class="cat-row"><span>${esc(x.category)}</span><div class="tr"><b style="width:${Math.max(3, x.total / max * 100).toFixed(1)}%"></b></div><span>${fmt0(x.total)} <small>${x.pct}%</small></span></div>`).join('')}</div><p class="count">Total spent: <b>${fmt(b.total)}</b> in ${b.items.reduce((s, x) => s + x.count, 0)} expense${b.items.reduce((s, x) => s + x.count, 0) === 1 ? '' : 's'}</p>` : '<div class="empty-card">No spending recorded for this period.</div>';
}
function adRenderRecent() {
  const d = adData, card = d.account.type === 'card', f = d.filter, on = adActive();
  const desc = [f.from && `from ${adDate(f.from)}`, f.to && `to ${adDate(f.to)}`, f.q && `matching "${f.q}"`, f.dir !== 'all' && (f.dir === 'in' ? 'cash in only' : 'cash out only')].filter(Boolean).join(', ');
  $('ad-fsum').innerHTML = on ? `<b>${f.count}</b> transaction${f.count === 1 ? '' : 's'} ${esc(desc)} · cash in <b>${fmt(f.in)}</b> · cash out <b>${fmt(f.out)}</b>` : `${d.total_entries} transaction${d.total_entries === 1 ? '' : 's'} in total`;
  $('ad-recent').innerHTML = d.recent.map(r => {
    const k = r.kind === 'transfer' ? 'mv' : r.delta > 0 ? 'in' : 'out', pos = r.delta > 0;
    return `<div class="act big"><span class="ic ${k}">${OV_ICON[k]}</span><div class="tx"><b>${esc(r.label)}</b><small>${esc([r.sub, r.note].filter(Boolean).join(' · '))}</small></div><span class="dt">${adDate(r.date)}</span><span class="am ${pos ? 'in' : ''}">${pos ? '+' : '−'}${fmt(Math.abs(r.delta))}</span><span class="bal" title="Balance after this entry">${card ? 'Owed ' + fmt(Math.max(0, -r.balance_after)) : fmt(r.balance_after)}</span></div>`;
  }).join('') || `<div class="empty-card">${d.total_entries ? 'No transactions match these filters.' : 'No transactions yet. Add an expense, income or transfer for this account.'}</div>`;
  $('ad-more').hidden = d.recent.length >= d.filtered_entries;
  const ex = adQuery(0); $('ad-export').href = `/api/accounts/${adId}/export.xlsx${ex ? '?' + ex : ''}`;
}
async function adPrint() {
  try {
    const d = await api(`/api/accounts/${adId}/summary?${adQuery(200)}`), a = d.account, card = a.type === 'card', f = d.filter;
    const desc = [f.from && `from ${adDate(f.from)}`, f.to && `to ${adDate(f.to)}`, f.q && `matching "${f.q}"`, f.dir !== 'all' && (f.dir === 'in' ? 'cash in only' : 'cash out only')].filter(Boolean).join(', ') || 'all transactions';
    $('print-report').innerHTML = `<h1>${esc(a.name)} – transactions</h1><p>${esc(TYPE_NAME[a.type])}${a.provider ? ' · ' + esc(a.provider) : ''}${a.acct_no ? ' ••' + esc(a.acct_no) : ''} · ${esc(desc)} · printed ${esc(today())}</p>
      <p>${card ? 'Balance owed' : 'Balance'}: <strong>${fmt(card ? d.owed : d.balance)}</strong>${card && a.credit_limit != null ? ` · Credit limit ${fmt(a.credit_limit)} · Available ${fmt(d.available)}` : ''} · Cash in (shown): <strong>${fmt(f.in)}</strong> · Cash out (shown): <strong>${fmt(f.out)}</strong></p>
      <table><thead><tr><th>Date</th><th>Details</th><th>Category / note</th><th class="num">Cash in</th><th class="num">Cash out</th><th class="num">${card ? 'Owed after' : 'Balance'}</th></tr></thead><tbody>${d.recent.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.label)}</td><td>${esc([r.sub, r.note].filter(Boolean).join(' · '))}</td><td class="num">${r.delta > 0 ? fmt(r.delta) : ''}</td><td class="num">${r.delta < 0 ? fmt(-r.delta) : ''}</td><td class="num">${card ? fmt(Math.max(0, -r.balance_after)) : fmt(r.balance_after)}</td></tr>`).join('')}</tbody></table>
      ${d.filtered_entries > d.recent.length ? `<p>Showing the newest ${d.recent.length} of ${d.filtered_entries} matching transactions. Use "Export to Excel" for the full list.</p>` : ''}`;
    window.print();
  } catch (e) { showToast(e.message, null); }
}
function adRange(kind) {
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, [sy, sm, sd] = adData.month_range[0].split('-').map(Number);
  const start = new Date(sy, sm - 1, sd), dayBefore = d => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
  if (kind === 'month') return [iso(start), iso(dayBefore(new Date(sy, sm, sd)))];
  if (kind === 'last') return [iso(new Date(sy, sm - 2, sd)), iso(dayBefore(start))];
  if (kind === '3m') return [iso(new Date(sy, sm - 3, sd)), ''];
  return ['', ''];
}
const adRefilter = () => { adLimit = 15; adLoad(); };

function adInit() {
  if (adReady) return; adReady = true;
  const _ra = renderAccounts; renderAccounts = function () { _ra.apply(this, arguments); adRenderGroups(); };
  const _la = loadAccounts; loadAccounts = async function () { const r = await _la.apply(this, arguments); if (!$('view-acctdetail').hidden) adLoad(); return r; };
  adRenderGroups();
  $('acct-list').addEventListener('click', ev => {
    if (ev.target.closest('button') && !ev.target.closest('[data-open]')) return;       // Statement / Reconcile / Edit / Delete are handled elsewhere
    const w = ev.target.closest('.acct-wrap'); if (w) adOpen(w.dataset.openCard);
  });
  $('acct-list').addEventListener('keydown', ev => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList.contains('acct-wrap')) { ev.preventDefault(); adOpen(ev.target.dataset.openCard); } });
  $('ad-back').onclick = () => goTab('accounts');
  $('ad-filter').addEventListener('click', ev => { const f = ev.target.dataset.f; if (!f) return; adDir = f; document.querySelectorAll('#ad-filter button').forEach(b => b.classList.toggle('on', b === ev.target)); adRefilter(); });
  const chipsOff = () => document.querySelectorAll('#ad-chips [data-r]').forEach(b => b.classList.remove('on'));
  $('ad-from').addEventListener('change', () => { adFrom = $('ad-from').value; chipsOff(); adRefilter(); });
  $('ad-to').addEventListener('change', () => { adTo = $('ad-to').value; chipsOff(); adRefilter(); });
  $('ad-q').addEventListener('input', () => { clearTimeout(adTimer); adTimer = setTimeout(() => { adQ = $('ad-q').value.trim(); adRefilter(); }, 300); });
  $('ad-chips').addEventListener('click', ev => {
    const r = ev.target.dataset.r; if (!r || !adData) return;
    [adFrom, adTo] = adRange(r); $('ad-from').value = adFrom; $('ad-to').value = adTo; chipsOff(); if (r !== 'all') ev.target.classList.add('on'); adRefilter();
  });
  $('ad-clear').onclick = () => { adDir = 'all'; adFrom = adTo = adQ = ''; $('ad-from').value = $('ad-to').value = $('ad-q').value = ''; chipsOff(); document.querySelectorAll('#ad-filter button').forEach(b => b.classList.toggle('on', b.dataset.f === 'all')); adRefilter(); };
  $('ad-print').onclick = adPrint;
  $('ad-more').onclick = () => { adLimit += 20; adLoad(); };
  $('view-acctdetail').addEventListener('click', ev => {
    const k = ev.target.closest('[data-ad]'); if (!k) return; const id = String(adId);
    if (k.dataset.ad === 'expense') { goTab('expenses'); $('account').value = id; }
    else if (k.dataset.ad === 'income') { goTab('income'); $('inc-account').value = id; }
    else { goTab('accounts'); setTimeout(() => { if (k.dataset.ad === 'move') { $('tr-from').value = id; $('tr-from').scrollIntoView({behavior: 'smooth', block: 'center'}); } else accountClick({target: {dataset: {[k.dataset.ad]: id}}}); }, 250); }
  });
}
{ const _e = extras2Init; extras2Init = async function () { await _e.apply(this, arguments); adInit(); }; }
