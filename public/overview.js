/* Overview dashboard + the right-hand "recent activities" panel. Loaded before app.js; starts from ovInit(). */
let ovReady = false, ovTimer = null;
const OV_ICON = {
  out: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M8 7h9v9"/></svg>',
  in: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 7L7 17M16 17H7V8"/></svg>',
  mv: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>',
};
const ovK = v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(Math.abs(v) % 1000 === 0 ? 0 : 1) + 'k' : String(Math.round(v));
const ovEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

function ovSmooth(p) {              // smooth curve through points
  if (p.length < 2) return '';
  let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i - 1] || p[i], b = p[i], c = p[i + 1], e = p[i + 2] || c;
    d += ` C${(b[0] + (c[0] - a[0]) / 6).toFixed(1)},${(b[1] + (c[1] - a[1]) / 6).toFixed(1)} ${(c[0] - (e[0] - b[0]) / 6).toFixed(1)},${(c[1] - (e[1] - b[1]) / 6).toFixed(1)} ${c[0].toFixed(1)},${c[1].toFixed(1)}`;
  }
  return d;
}
function ovFlow(m) {
  const W = 560, H = 215, L = 40, R = 12, T = 14, B = 30, mx = Math.max(1, ...m.flatMap(x => [x.spent, x.income])) * 1.08;
  const x = i => L + i * (W - L - R) / (m.length - 1), y = v => T + (H - T - B) * (1 - v / mx);
  const pts = k => m.map((p, i) => [x(i), y(p[k])]), sp = pts('spent'), inc = pts('income');
  const grid = [0, .5, 1].map(f => `<line x1="${L}" x2="${W - R}" y1="${y(mx * f)}" y2="${y(mx * f)}" stroke="var(--line)" stroke-dasharray="4 5"/><text x="${L - 8}" y="${y(mx * f) + 4}" text-anchor="end" fill="var(--muted)" font-size="11">${ovK(mx * f)}</text>`).join('');
  const lbl = m.map((p, i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" fill="var(--muted)" font-size="11">${MONTHS[Number(p.ym.slice(5)) - 1]}</text>`).join('');
  const area = `${ovSmooth(sp)} L${x(m.length - 1)},${y(0)} L${x(0)},${y(0)} Z`, last = sp[sp.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Spending and income, last 12 months"><defs><linearGradient id="ovg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>${grid}${lbl}
    <path d="${area}" fill="url(#ovg)"/><path d="${ovSmooth(inc)}" fill="none" stroke="var(--pink)" stroke-width="3" stroke-linecap="round"/><path d="${ovSmooth(sp)}" fill="none" stroke="var(--accent)" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="6" fill="var(--card)" stroke="var(--accent)" stroke-width="3"/></svg>`;
}
function ovBars(m4) {
  const W = 420, H = 215, L = 44, B = 32, T = 12, mx = Math.max(1, ...m4.flatMap(x => [x.spent, x.income])) * 1.1, y = v => T + (H - T - B) * (1 - v / mx), gw = (W - L - 10) / m4.length;
  const grid = [0, .5, 1].map(f => `<line x1="${L}" x2="${W - 6}" y1="${y(mx * f)}" y2="${y(mx * f)}" stroke="var(--line)" stroke-dasharray="4 5"/><text x="${L - 8}" y="${y(mx * f) + 4}" text-anchor="end" fill="var(--muted)" font-size="11">${ovK(mx * f)}</text>`).join('');
  const bars = m4.map((p, i) => { const cx = L + gw * i + gw / 2, h1 = (H - T - B) * p.income / mx, h2 = (H - T - B) * p.spent / mx;
    return `<rect x="${cx - 13}" y="${y(0) - h1}" width="10" height="${Math.max(h1, 2)}" rx="5" fill="var(--soft2)"><title>${p.ym} income ${fmt(p.income)}</title></rect><rect x="${cx + 3}" y="${y(0) - h2}" width="10" height="${Math.max(h2, 2)}" rx="5" fill="var(--accent)"><title>${p.ym} spent ${fmt(p.spent)}</title></rect><text x="${cx}" y="${H - 9}" text-anchor="middle" fill="var(--muted)" font-size="11">${MONTHS[Number(p.ym.slice(5)) - 1]}</text>`; }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Income and spending, last 4 months">${grid}${bars}</svg>`;
}
function ovRing(pct, big, label) {
  const r = 66, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, pct)) / 100 * c;
  return `<div class="ring-wrap"><svg viewBox="0 0 180 180" role="img" aria-label="${ovEsc(label)}"><circle cx="90" cy="90" r="${r}" fill="none" stroke="var(--accent-soft)" stroke-width="13"/>
    <circle cx="90" cy="90" r="${r}" fill="none" stroke="var(--accent)" stroke-width="13" stroke-linecap="round" stroke-dasharray="${v.toFixed(1)} ${(c - v).toFixed(1)}" transform="rotate(-90 90 90)"/>
    <text x="90" y="88" text-anchor="middle" fill="var(--ink)" font-size="21" font-weight="800">${ovEsc(big)}</text><text x="90" y="109" text-anchor="middle" fill="var(--muted)" font-size="11">${ovEsc(label)}</text></svg></div>`;
}
function ovSpark(vals) {
  const W = 220, H = 62, mn = Math.min(...vals), mx = Math.max(...vals), span = mx - mn || 1, x = i => 6 + i * (W - 16) / (vals.length - 1), y = v => 8 + (H - 16) * (1 - (v - mn) / span), p = vals.map((v, i) => [x(i), y(v)]), l = p[p.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" style="width:100%"><path d="${ovSmooth(p)}" fill="none" stroke="var(--pink)" stroke-width="3" stroke-linecap="round"/><circle cx="${l[0]}" cy="${l[1]}" r="5" fill="var(--card)" stroke="var(--pink)" stroke-width="3"/></svg>`;
}

async function ovRefresh() {
  try {
    const cm = curMonth();
    const [t, ex, accs, act] = await Promise.all([api('/api/trends?end=' + cm), api('/api/expenses?month=' + cm), api('/api/accounts'), api('/api/activity')]);
    const m = t.months, cur = m[m.length - 1], prev = m[m.length - 2], act0 = accs.filter(a => !a.archived);
    // balance card
    const assets = act0.filter(a => a.type !== 'card').reduce((s, a) => s + Number(a.balance), 0), owed = act0.filter(a => a.type === 'card').reduce((s, a) => s - Number(a.balance), 0);
    $('ov-balance').innerHTML = act0.length
      ? `<div class="bal-top"><div class="bal-chip"><i></i><i></i></div><span class="bal-tag">${act0.length} ACCOUNT${act0.length > 1 ? 'S' : ''}</span></div>
         <div><div class="bal-label">Total balance</div><div class="bal-amt">${fmt(assets - owed)}</div></div>
         <div class="bal-row"><div><span>IN BANKS, WALLETS, CASH</span><b>${fmt(assets)}</b></div><div><span>OWED ON CARDS</span><b>${fmt(owed)}</b></div></div>`
      : `<div class="bal-top"><div class="bal-chip"><i></i><i></i></div></div><div><div class="bal-label">Total balance</div><div class="bal-amt">0.00</div></div><div><button class="btn-light" data-goto="accounts">Add your first account</button></div>`;
    // charts
    $('ov-flow').innerHTML = ovFlow(m); $('ov-bars').innerHTML = ovBars(m.slice(-4));
    const net = cur.income - cur.spent;
    if (cur.income > 0) { const pct = net / cur.income * 100; $('ov-ring').innerHTML = ovRing(pct, fmt0(Math.abs(net)), net >= 0 ? 'saved this month' : 'overspent'); $('ov-ring-sub').innerHTML = `<span class="pill${net < 0 ? ' down' : ''}">${net >= 0 ? Math.round(pct) + '% of income' : 'over income'}</span>`; }
    else { $('ov-ring').innerHTML = ovRing(0, fmt0(cur.spent), 'spent, no income yet'); $('ov-ring-sub').textContent = ''; }
    // categories
    const by = {}; ex.forEach(e => by[e.category] = (by[e.category] || 0) + Number(e.amount));
    const list = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 6), top = list.length ? list[0][1] : 1, bud = Object.fromEntries(categories.map(c => [c.name, Number(c.monthly_budget) || 0]));
    $('ov-cats').innerHTML = list.length ? `<div class="cats-list">${list.map(([n, v]) => { const b = bud[n], w = Math.min(100, v / (b || top) * 100), over = b && v > b; return `<div class="cat-row${over ? ' over' : ''}"><span>${ovEsc(n)}</span><div class="tr"><b style="width:${w.toFixed(1)}%"></b></div><span>${fmt0(v)}${b ? ` <small>/ ${fmt0(b)}</small>` : ''}</span></div>`; }).join('')}</div>` : '<div class="empty-card">No spending yet this month. Add your first expense with the button above.</div>';
    // right panel
    const diff = prev && (prev.income - prev.spent) !== 0 ? Math.round((net - (prev.income - prev.spent)) / Math.abs(prev.income - prev.spent) * 100) : null;
    $('rail-net').innerHTML = `${ovSpark(m.slice(-6).map(x => x.income - x.spent))}<div class="lbl">Net this month ${diff === null ? '' : `<span class="pill${diff < 0 ? ' down' : ''}">${diff > 0 ? '+' : ''}${diff}%</span>`}</div><div class="big">${net < 0 ? '−' : ''}${fmt(Math.abs(net))}</div>`;
    $('rail-date').textContent = new Date().toLocaleDateString(undefined, {weekday: 'long', day: 'numeric', month: 'long'});
    const td = today(), yd = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    const day = d => d === td ? 'TODAY' : d === yd ? 'YESTERDAY' : new Date(d + 'T00:00:00').toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'}).toUpperCase();
    let last = '', html = '';
    act.forEach(a => {
      const dt = String(a.dt).slice(0, 10), dd = day(dt); if (dd !== last) { html += `<div class="act-day">${dd}</div>`; last = dd; }
      const k = a.kind === 'expense' ? 'out' : a.kind === 'income' ? 'in' : 'mv', sub = a.kind === 'expense' ? [a.sub, a.account_id ? acctName(a.account_id) : ''].filter(Boolean).join(' · ') : a.kind === 'income' ? ['Income', a.account_id ? acctName(a.account_id) : ''].filter(Boolean).join(' · ') : 'Transfer';
      html += `<div class="act"><span class="ic ${k}">${OV_ICON[k]}</span><div class="tx"><b>${ovEsc(a.title)}</b><small>${ovEsc(sub)}</small></div><span class="am ${k === 'in' ? 'in' : ''}">${k === 'out' ? '−' : k === 'in' ? '+' : ''}${fmt(Math.abs(a.amt))}</span></div>`;
    });
    $('rail-activity').innerHTML = html || '<div class="empty-card">Nothing recorded yet.</div>';
  } catch (e) { /* the page keeps working even if the dashboard cannot load */ }
}
const ovSchedule = () => { clearTimeout(ovTimer); ovTimer = setTimeout(ovRefresh, 350); };

function ovInit() {
  if (ovReady) { ovRefresh(); return; }
  ovReady = true;
  for (const n of ['load', 'loadAccounts', 'loadIncome']) {          // refresh the dashboard whenever data changes
    const f = window[n]; if (typeof f !== 'function') continue;
    window[n] = async function () { const r = await f.apply(this, arguments); ovSchedule(); return r; };
  }
  document.getElementById('tabs').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-view]'); if (!b) return;
    $('page-title').textContent = b.querySelector('span') ? b.querySelector('span').textContent : b.textContent.trim();
    if (b.dataset.view === 'overview') ovRefresh();
  });
  document.body.addEventListener('click', ev => { const g = ev.target.closest('[data-goto]'); if (g) goTab(g.dataset.goto); });
  ovRefresh();
}
{ const _e2 = extras2Init; extras2Init = async function () { await _e2.apply(this, arguments); ovInit(); }; }
