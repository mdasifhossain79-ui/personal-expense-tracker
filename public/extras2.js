/* More features, part 2. Loaded before app.js; starts from extras2Init() (called by boot). */
let extras2Ready = false, selected = new Set(), assetsData = {items: []}, presets = [], whatIfRows = [];

/* ---------- lock screen: quick PIN (works before the app has started, so it uses plain DOM calls) ---------- */
(function () {
  const g = id => document.getElementById(id), lock = g('lock');
  if (!lock || !g('pin-lock-form')) return;
  async function check() {
    if (lock.hidden) return;
    try {
      const s = await (await fetch('/api/auth/pin/status')).json();
      g('pin-lock-form').hidden = !s.available; g('lock-form').hidden = !!s.available; g('pin-lock-pw').hidden = !s.available;
      if (s.available) g('pin-lock-input').focus();
    } catch {}
  }
  new MutationObserver(check).observe(lock, {attributes: true, attributeFilter: ['hidden']});
  g('pin-lock-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const r = await fetch('/api/auth/pin', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({pin: g('pin-lock-input').value})}), d = await r.json();
    if (!r.ok) { g('pin-lock-msg').textContent = d.error || 'Wrong PIN.'; g('pin-lock-input').value = ''; if (/password/i.test(d.error || '')) check(); return; }
    g('pin-lock-input').value = ''; g('pin-lock-msg').textContent = ''; lock.hidden = true; g('lock-btn').hidden = false; await boot();
  });
  g('pin-lock-pw').addEventListener('click', () => { g('pin-lock-form').hidden = true; g('lock-form').hidden = false; g('pin-lock-pw').hidden = true; g('lock-pw').focus(); });
})();

/* ---------- 1. bulk edit ---------- */
function bulkInject() {
  const body = $('rows'), table = body.closest('table'), head = table.querySelector('thead tr');
  if (head && !head.querySelector('.bsel-all')) { const th = document.createElement('th'); th.innerHTML = '<input type="checkbox" class="bsel-all" aria-label="Select all shown">'; head.prepend(th); }
  [...body.querySelectorAll('tr')].forEach(tr => {
    if (tr.querySelector('.bsel')) return;
    const b = tr.querySelector('[data-edit]'); if (!b) return;
    const td = document.createElement('td'); td.innerHTML = `<input type="checkbox" class="bsel" data-id="${b.dataset.edit}" aria-label="Select" ${selected.has(b.dataset.edit) ? 'checked' : ''}>`; tr.prepend(td);
  });
  updateBulkBar(); showProjectChips();
}
function updateBulkBar() {
  const n = selected.size; $('bulk-bar').hidden = n === 0; $('bulk-count').textContent = `${n} selected`;
  const all = document.querySelector('.bsel-all'); if (all) { const boxes = [...document.querySelectorAll('#rows .bsel')]; all.checked = boxes.length > 0 && boxes.every(b => b.checked); }
}
async function showProjectChips() {
  const ids = [...document.querySelectorAll('#rows .bsel')].map(b => b.dataset.id); if (!ids.length) return;
  try {
    const m = await api('/api/projects/links?kind=expense&ids=' + ids.join(','));
    document.querySelectorAll('#rows tr').forEach(tr => { const id = (tr.querySelector('.bsel') || {}).dataset?.id, p = m[id]; tr.querySelector('.pj')?.remove(); if (p) { const sp = document.createElement('span'); sp.className = 'note pj'; sp.textContent = '▸ ' + p; tr.children[2].append(sp); } });
  } catch {}
}
function fillBulkAcct() {
  const cur = $('bulk-acct').value;
  $('bulk-acct').innerHTML = '<option value="">Account: no change</option><option value="none">Account: remove</option>' + accounts.filter(a => !a.archived).map(a => `<option value="${a.id}">${esc(acctLabel(a))}</option>`).join('');
  $('bulk-acct').value = cur;
}
async function loadProjectList() { try { const p = await api('/api/projects'); $('proj-list').innerHTML = p.map(x => `<option value="${esc(x.project)}"></option>`).join(''); return p; } catch { return []; } }

/* ---------- 2. saved import setups ---------- */
const PRESET_COLS = ['date', 'title', 'amount', 'category', 'note', 'acctcol'];
async function loadPresets() {
  try { presets = await api('/api/presets'); $('preset-sel').innerHTML = '<option value="">(none)</option>' + presets.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join(''); } catch {}
}
function currentSetup() {
  const o = {headers: {}, fmt: $('m-fmt').value, sign: $('m-sign').value, income: $('m-in').value};
  PRESET_COLS.forEach(k => { const sel = $('m-' + k), t = sel.selectedOptions[0]; o.headers[k] = t && sel.value !== '-1' ? t.textContent : ''; });
  return o;
}
function applySetup(o) {
  PRESET_COLS.forEach(k => { const sel = $('m-' + k), want = (o.headers || {})[k]; if (!want) { sel.value = '-1'; return; } const opt = [...sel.options].find(x => x.textContent === want); if (opt) sel.value = opt.value; });
  if (o.fmt) $('m-fmt').value = o.fmt; if (o.sign) $('m-sign').value = o.sign; if (o.income) $('m-in').value = o.income;
}
async function autoPreset() {                       // after a file is chosen, apply a saved setup whose column names all appear in it
  for (let i = 0; i < 30 && $('map-form').hidden; i++) await new Promise(r => setTimeout(r, 100));
  if ($('map-form').hidden) return;
  const have = [...$('m-date').options].map(o => o.textContent);
  const hit = presets.map(p => ({p, o: JSON.parse(p.data)})).find(x => Object.values(x.o.headers || {}).filter(Boolean).length >= 3 && Object.values(x.o.headers).filter(Boolean).every(h => have.includes(h)));
  if (hit) { applySetup(hit.o); $('preset-sel').value = hit.p.id; $('csv-msg').textContent += ` Used your saved setup "${hit.p.name}".`; }
}

/* ---------- 4. receipts: several files, drag and drop, phone camera ---------- */
async function uploadReceipts(files) {
  const list = [...files]; if (!list.length) return; let done = 0;
  for (const f of list) {
    try {
      const r = await fetch(`/api/expenses/${rcpId}/receipts`, {method: 'POST', headers: {'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name)}, body: f});
      if (r.status === 401) { showLock(); return; }
      const d = await r.json(); if (!r.ok) throw new Error(f.name + ': ' + d.error); done++;
    } catch (e) { $('rcp-msg').textContent = e.message; }
  }
  if (done) openReceipts(rcpId);
}

/* ---------- 5. pace check ---------- */
function renderPace() {
  const el = $('pace'); el.innerHTML = '';
  if ($('month').value !== curMonth()) return;
  const start = periodStartDate(), end = new Date(start.getFullYear(), start.getMonth() + 1, periodStartDay), t = new Date(); t.setHours(0, 0, 0, 0);
  const elapsed = Math.round((t - start) / 864e5) + 1, total = Math.round((end - start) / 864e5);
  if (elapsed < 3 || elapsed >= total) return;
  const spent = monthSpent(), lines = categories.filter(c => Number(c.monthly_budget) > 0).map(c => ({n: c.name, b: Number(c.monthly_budget), s: spent[c.name] || 0}))
    .filter(x => x.s > 0 && x.s <= x.b).map(x => ({...x, p: x.s / elapsed * total})).filter(x => x.p > x.b * 1.05).sort((a, b) => b.p / b.b - a.p / a.b);
  el.innerHTML = lines.map(x => `<div class="alert warn">At this pace ${esc(x.n)} will reach about ${fmt0(x.p)} by the end of the month (budget ${fmt0(x.b)}).</div>`).join('');
}

/* ---------- 6. what-if ---------- */
async function loadWhatIf() {
  try {
    const r = await api('/api/spend/avg?months=6'); whatIfRows = r.categories.slice(0, 10);
    $('wi-rows').innerHTML = whatIfRows.map((c, i) => `<tr><td>${esc(c.category)}</td><td class="num">${fmt0(c.monthly)}</td><td><input type="range" min="0" max="50" step="5" value="0" data-wi="${i}" aria-label="Cut ${esc(c.category)} by percent"> <span id="wi-pct-${i}">0%</span></td><td class="num" id="wi-save-${i}">0</td></tr>`).join('') || '<tr><td colspan="4" class="count">Not enough spending history yet.</td></tr>';
    wiTotal();
  } catch (e) { $('wi-total').textContent = e.message; }
}
function wiTotal() {
  let year = 0; whatIfRows.forEach((c, i) => { const el = document.querySelector(`[data-wi="${i}"]`); if (!el) return; const p = Number(el.value), s = c.monthly * p / 100 * 12; year += s; $('wi-pct-' + i).textContent = p + '%'; $('wi-save-' + i).textContent = fmt0(s); });
  $('wi-total').textContent = year > 0 ? `Cutting these would save about ${fmt0(year)} a year (${fmt0(year / 12)} a month), based on your average spending over the last 6 finished months.` : 'Move a slider to see how much you would save.';
}

/* ---------- 8. variable income check ---------- */
async function loadVariableIncome() {
  try {
    const t = await api('/api/trends?end=' + curMonth()), last = t.months.slice(5, 11), inc = last.map(m => m.income).filter(v => v > 0).sort((a, b) => a - b), spent = last.map(m => m.spent).filter(v => v > 0);
    if (!inc.length) { $('vi-out').textContent = 'No income recorded in the last 6 finished months.'; return; }
    const avg = inc.reduce((s, v) => s + v, 0) / inc.length, med = inc[Math.floor(inc.length / 2)], low = inc[0], high = inc[inc.length - 1], avgSpend = spent.length ? spent.reduce((s, v) => s + v, 0) / spent.length : 0;
    const cash = accounts.filter(a => !a.archived && a.type !== 'card').reduce((s, a) => s + Number(a.balance), 0) - accounts.filter(a => !a.archived && a.type === 'card').reduce((s, a) => s - Number(a.balance), 0);
    const swing = high && low ? Math.round((high - low) / avg * 100) : 0;
    $('vi-out').innerHTML = `<ul><li>Lowest month: <strong>${fmt0(low)}</strong> · Median: ${fmt0(med)} · Average: ${fmt0(avg)} · Highest: ${fmt0(high)} (a ${swing}% swing)</li>
      <li>A safe planning figure is your lowest month: <strong>${fmt0(low)}</strong>. Budget around it and treat anything above as extra to save.</li>
      ${avgSpend ? `<li>You spend about ${fmt0(avgSpend)} a month. ${low < avgSpend ? `<span style="color:var(--danger)">Your lowest month was below that, so a slow month would dip into savings.</span>` : 'Even your lowest month covered that.'}</li>` : ''}
      ${avgSpend && accounts.length ? `<li>Money in your accounts (net of cards): ${fmt0(cash)}, enough for about <strong>${cash > 0 ? (cash / avgSpend).toFixed(1) : '0'} months</strong> of spending. A common target for uneven income is 3 to 6 months.</li>` : ''}</ul>`;
  } catch (e) { $('vi-out').textContent = e.message; }
}

/* ---------- 9. other assets and debts ---------- */
async function loadAssets() {
  try {
    assetsData = await api('/api/assets'); const acc = accounts.filter(a => !a.archived), accNet = acc.filter(a => a.type !== 'card').reduce((s, a) => s + Number(a.balance), 0) + acc.filter(a => a.type === 'card').reduce((s, a) => s + Number(a.balance), 0);
    $('as-total').textContent = assetsData.items.length ? `Other assets: ${fmt(assetsData.assets_total)} · Debts you owe: ${fmt(assetsData.debts_total)} · Whole net worth (accounts + assets − debts): ${fmt(accNet + assetsData.assets_total - assetsData.debts_total)}` : '';
    $('as-list').innerHTML = assetsData.items.map(a => `<div class="goal"><div class="goal-top"><strong>${esc(a.name)} <small class="count">${esc(a.kind === 'debt' ? 'Debt (you owe)' : a.kind)}${a.qty != null ? ` · ${Number(a.qty)} ${esc(a.unit || '')} × ${fmt(a.unit_price || 0)}` : ''}</small></strong><span>${a.kind === 'debt' ? '−' : ''}${fmt(a.value)}</span></div>${a.note ? `<p class="count">${esc(a.note)}</p>` : ''}
      <div class="goal-act"><button data-asup="${a.id}" data-has-unit="${a.qty != null ? 1 : 0}">${a.qty != null ? 'Update price' : 'Update value'}</button><button class="del" data-asdel="${a.id}">Delete</button></div></div>`).join('') || '<p class="empty">Nothing yet. Add gold, land, a vehicle, or money you owe someone.</p>';
    loadNetWorth();
  } catch (e) { $('as-msg').textContent = e.message; }
}
function asKindToggle() { const g = $('as-kind').value === 'gold' || $('as-kind').value === 'investment'; $('as-qty-wrap').hidden = !g; $('as-unit-wrap').hidden = !g; $('as-price-wrap').hidden = !g; if ($('as-kind').value === 'gold' && !$('as-unit').value) $('as-unit').value = 'gram'; }

/* ---------- 7. low-balance alerts ---------- */
async function loadLowBalance() {
  try {
    const l = await api('/api/alerts/balance');
    $('lb-list').innerHTML = l.map(a => `<tr><td>${esc(a.name)}</td><td class="num">${fmt(a.balance)}</td><td class="num"><input type="number" step="0.01" min="0" value="${a.min_balance ?? ''}" placeholder="No alert" data-lb="${a.id}" aria-label="Minimum balance for ${esc(a.name)}"></td></tr>`).join('') || '<tr><td colspan="3" class="count">Add a bank account or wallet first.</td></tr>';
  } catch {}
}
async function moreReminders() {
  try {
    const r = await api('/api/reminders/more');
    $('reminders').innerHTML += r.map(x => x.kind === 'below' ? `<div class="alert over">${esc(x.name)} is below your minimum (${fmt(x.balance)} against ${fmt(x.min)}).</div>` : `<div class="alert warn">${esc(x.name)} will drop to ${fmt(x.after)} after bills due this week (${fmt(x.bills)}), below your minimum of ${fmt(x.min)}.</div>`).join('');
  } catch {}
}

/* ---------- 10. projects / clients ---------- */
async function loadProjects() {
  try {
    const p = await api('/api/projects');
    $('proj-rows').innerHTML = p.map(x => `<tr><td>${esc(x.project)}</td><td class="num">${fmt(x.income)}</td><td class="num">${fmt(x.expenses)}</td><td class="num" style="${x.profit < 0 ? 'color:var(--danger)' : ''}"><strong>${x.profit < 0 ? '−' : ''}${fmt(Math.abs(x.profit))}</strong></td></tr>`).join('') || '<tr><td colspan="4" class="count">No projects yet. Select expenses on the Expenses tab and use "Project / client" in the bar, or press "Project" on an income row. Paid invoices count towards their client automatically.</td></tr>';
    $('proj-list').innerHTML = p.map(x => `<option value="${esc(x.project)}"></option>`).join('');
  } catch {}
}
async function incomeProjectUI() {
  const rows = [...document.querySelectorAll('#inc-rows tr')]; if (!rows.length) return;
  const ids = rows.map(tr => tr.querySelector('[data-iedit]')?.dataset.iedit).filter(Boolean);
  let m = {}; try { m = await api('/api/projects/links?kind=income&ids=' + ids.join(',')); } catch {}
  rows.forEach(tr => {
    const id = tr.querySelector('[data-iedit]')?.dataset.iedit; if (!id || tr.querySelector('[data-iproj]')) return;
    const act = tr.querySelector('td.act'); if (act) act.insertAdjacentHTML('afterbegin', `<button data-iproj="${id}" data-cur="${esc(m[id] || '')}">Project</button>`);
    if (m[id]) tr.children[1].insertAdjacentHTML('beforeend', `<span class="note">▸ ${esc(m[id])}</span>`);
  });
}

/* ---------- 11. expense claim sheet ---------- */
async function buildClaim() {
  const msg = $('claim-msg'); msg.textContent = '';
  try {
    const q = new URLSearchParams({from: $('claim-from').value, to: $('claim-to').value, tag: $('claim-tag').value.trim(), project: $('claim-proj').value.trim()});
    const rows = await api('/api/claim?' + q);
    if (!rows.length) { msg.textContent = 'No expenses match those filters.'; return; }
    const total = rows.reduce((s, r) => s + Number(r.amount), 0), title = $('claim-title').value.trim() || 'Expense claim';
    const imgs = rows.flatMap(r => r.receipts.filter(a => a.mime.startsWith('image/')).map(a => `<figure><img src="/api/receipts/${a.id}" alt=""><figcaption>${esc(r.spent_on)} · ${esc(r.title)} · ${fmt(r.amount)}</figcaption></figure>`));
    const pdfs = rows.flatMap(r => r.receipts.filter(a => !a.mime.startsWith('image/')).map(a => `${esc(r.title)}: ${esc(a.filename)}`));
    $('print-report').innerHTML = `<h1>${esc(title)}</h1><p>${esc($('claim-from').value || 'start')} to ${esc($('claim-to').value || 'today')} · Prepared ${esc(today())}</p>
      <table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th class="num">Amount</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.spent_on)}</td><td>${esc(r.title)}${r.note ? ' – ' + esc(r.note) : ''}</td><td>${esc(r.category)}</td><td class="num">${fmt(r.amount)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3"><strong>Total</strong></td><td class="num"><strong>${fmt(total)}</strong></td></tr></tfoot></table>
      ${imgs.length ? `<h2>Receipts</h2><div class="rcp-grid">${imgs.join('')}</div>` : ''}${pdfs.length ? `<p>PDF receipts (attach separately): ${pdfs.join('; ')}</p>` : ''}
      <p style="margin-top:2.5rem">Signature: ______________________ &nbsp; Date: ______________</p>`;
    msg.style.color = 'var(--accent)'; msg.textContent = `${rows.length} expenses, total ${fmt(total)}. Opening the print dialog (choose "Save as PDF" to keep a copy).`;
    setTimeout(() => window.print(), 600);
  } catch (e) { msg.style.color = ''; msg.textContent = e.message; }
}

/* ---------- 12/15. data health + status page ---------- */
async function loadHealth() {
  try {
    const s = await api('/api/status'), c = s.counts;
    $('status-box').innerHTML = `<table><tbody>
      <tr><td>Database</td><td>${s.database.connected ? 'Connected' : '<strong style="color:var(--danger)">Not connected</strong>'} · MySQL ${esc(s.database.version || '')}</td></tr>
      <tr><td>App</td><td>Version ${esc(s.app.version)} · Node ${esc(s.app.node)} · running for ${s.app.uptime_minutes} min</td></tr>
      <tr><td>Last backup</td><td>${s.last_backup ? `${esc(s.last_backup.file)} (${s.last_backup.hours_ago < 48 ? s.last_backup.hours_ago + ' hours' : Math.round(s.last_backup.hours_ago / 24) + ' days'} ago)` : '<strong style="color:var(--danger)">None yet</strong>'}</td></tr>
      <tr><td>Disk used</td><td>Backups ${s.sizes_mb.backups} MB · Receipts ${s.sizes_mb.receipts} MB</td></tr>
      <tr><td>Your data</td><td>${c.expenses} expenses · ${c.income} income · ${c.accounts} accounts · ${c.transfers} transfers · ${c.goals} goals · ${c.attachments} receipts</td></tr>
      <tr><td>Protection</td><td>Password lock ${s.flags.password ? 'on' : 'off'} · Encrypted backups ${s.flags.encrypted_backups ? 'on' : 'off'} · Phone access ${s.flags.lan ? 'on' : 'off'}</td></tr></tbody></table>`;
  } catch (e) { $('status-box').textContent = 'Could not read the status: ' + e.message; }
  try {
    const h = await api('/api/health/data');
    $('health-list').innerHTML = h.map(x => `<div class="alert ${x.level === 'warn' ? 'warn' : ''}">${esc(x.text)}${x.action ? ` <button data-hact="${esc(JSON.stringify(x.action))}">${esc(x.action.label)}</button>` : ''}</div>`).join('') || '<p class="count">Everything looks tidy. Nothing to fix.</p>';
  } catch (e) { $('health-list').textContent = e.message; }
}

/* ---------- 13. PIN + lock when you switch away ---------- */
async function loadPinState() {
  try { const s = await api('/api/auth/pin/status'); $('pin-state').textContent = s.set ? 'A quick PIN is set. At the lock screen you can use it instead of your password for 14 days after your last password sign-in.' : 'No quick PIN yet. Set one to unlock faster than typing your password.'; $('pin-remove').hidden = !s.set; } catch {}
  $('lock-hide').checked = localStorage.getItem('ledger_lock_on_hide') === '1';
}

/* ---------- 14. keyboard shortcuts ---------- */
function shortcuts(ev) {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const t = ev.target, typing = t.matches && t.matches('input, select, textarea, [contenteditable]');
  if (typing || !$('lock').hidden || document.querySelector('dialog[open]')) return;
  const k = ev.key, onExp = !$('view-expenses').hidden;
  if (k === 'n' || k === 'N') { ev.preventDefault(); goTab('expenses'); $('quick-input').focus(); }
  else if (k === '/') { ev.preventDefault(); $('gsearch').focus(); }
  else if (k === '?') showToast('Shortcuts: N = new expense · / = search · ← → = previous/next month · G then E, I, A, R = go to Expenses, Income, Accounts, Reports', null);
  else if (onExp && k === 'ArrowLeft') { ev.preventDefault(); $('prev').click(); }
  else if (onExp && k === 'ArrowRight') { ev.preventDefault(); $('next').click(); }
  else if (k === 'g' || k === 'G') { window.__g = Date.now(); }
  else if (window.__g && Date.now() - window.__g < 1500) { const m = {e: 'expenses', i: 'income', a: 'accounts', r: 'report', t: 'tracker', b: 'backup', h: 'health'}[k.toLowerCase()]; if (m) { ev.preventDefault(); goTab(m); } window.__g = 0; }
}

/* ---------- start ---------- */
async function extras2Init() {
  if (extras2Ready) { loadPresets(); loadProjectList(); fillBulkAcct(); return; }
  extras2Ready = true;
  // wrap existing functions so new things appear without touching the old code
  const _la = loadAccounts; loadAccounts = async function () { await _la.apply(this, arguments); fillBulkAcct(); };
  const _er = extraReminders; extraReminders = async function () { await _er.apply(this, arguments); await moreReminders(); };
  const _ra = renderAlerts; renderAlerts = function () { _ra.apply(this, arguments); renderPace(); };
  const _nw = loadNetWorth; loadNetWorth = async function () {          // net worth chart also counts other assets and debts
    try {
      const have = accounts.some(a => !a.archived); if (!have) return _nw();
      const [m, h] = await Promise.all([api('/api/networth'), api('/api/assets/history')]), by = Object.fromEntries(h.map(x => [x.ym, x]));
      const merged = m.map(p => { const x = by[p.ym] || {assets: 0, debts: 0}, assets = p.assets + x.assets, owed = p.owed + x.debts; return {...p, assets, owed, net: Math.round((assets - owed) * 100) / 100}; });
      $('nw-chart').innerHTML = netChart(merged);
    } catch { return _nw(); }
  };
  document.getElementById('tabs').addEventListener('click', ev => {
    const v = ev.target.dataset.view; if (!v) return;
    if (v === 'accounts') { loadAssets(); loadLowBalance(); }
    if (v === 'report') { loadWhatIf(); loadVariableIncome(); loadProjects(); }
    if (v === 'health') loadHealth();
    if (v === 'security') loadPinState();
    if (v === 'tracker') { loadProjectList(); }
    if (v === 'income') setTimeout(incomeProjectUI, 700);
  });
  // rows get checkboxes / project buttons whenever the tables are redrawn
  new MutationObserver(bulkInject).observe($('rows'), {childList: true});
  new MutationObserver(incomeProjectUI).observe($('inc-rows'), {childList: true});
  $('rows').addEventListener('change', ev => { const b = ev.target.closest('.bsel'); if (!b) return; b.checked ? selected.add(b.dataset.id) : selected.delete(b.dataset.id); updateBulkBar(); });
  $('rows').closest('table').addEventListener('change', ev => { if (!ev.target.classList.contains('bsel-all')) return; document.querySelectorAll('#rows .bsel').forEach(b => { b.checked = ev.target.checked; ev.target.checked ? selected.add(b.dataset.id) : selected.delete(b.dataset.id); }); updateBulkBar(); });
  $('bulk-clear').onclick = () => { selected.clear(); document.querySelectorAll('#rows .bsel').forEach(b => b.checked = false); updateBulkBar(); };
  $('bulk-apply').onclick = async () => {
    const body = {ids: [...selected]}; if ($('bulk-cat').value.trim()) body.category = $('bulk-cat').value.trim(); if ($('bulk-tags').value.trim()) body.add_tags = $('bulk-tags').value.trim();
    if ($('bulk-acct').value) body.account_id = $('bulk-acct').value; if ($('bulk-proj').value.trim()) body.project = $('bulk-proj').value.trim();
    if (Object.keys(body).length === 1) { showToast('Choose what to change first: category, tags, account or project.', null); return; }
    try { const r = await api('/api/bulk/expenses', {method: 'POST', body: JSON.stringify(body)}); selected.clear(); ['bulk-cat', 'bulk-tags', 'bulk-proj'].forEach(i => $(i).value = ''); $('bulk-acct').value = ''; await load(); loadAccounts(); loadTags(); loadCategories(); loadProjectList(); showToast(`Updated ${r.updated} expense${r.updated === 1 ? '' : 's'}.`, null); }
    catch (e) { showToast(e.message, null); }
  };
  $('bulk-del').onclick = async () => {
    const ids = [...selected]; if (!ids.length) return;
    try {
      const r = await api('/api/bulk/expenses', {method: 'POST', body: JSON.stringify({ids, delete: true})}); selected.clear(); await load(); loadAccounts();
      showToast(`Deleted ${r.deleted} expense${r.deleted === 1 ? '' : 's'}.`, async () => { for (const e of r.items) await api('/api/expenses', {method: 'POST', body: JSON.stringify({spent_on: e.spent_on, title: e.title, category: e.category, amount: e.amount, note: e.note, tags: e.tags, account_id: e.account_id, restore_from: e.id})}); load(); loadAccounts(); });
    } catch (e) { showToast(e.message, null); }
  };
  $('inc-rows').addEventListener('click', async ev => {
    const id = ev.target.dataset.iproj; if (!id) return;
    const p = prompt('Project or client for this income (leave empty to remove):', ev.target.dataset.cur || ''); if (p === null) return;
    try { await api('/api/projects/link', {method: 'POST', body: JSON.stringify({kind: 'income', ids: [id], project: p})}); loadIncome(); loadProjectList(); } catch (e) { showToast(e.message, null); }
  });
  // import setups
  $('csv-file').addEventListener('change', () => { if ($('csv-file').files[0]) autoPreset(); });
  $('preset-save').onclick = async () => {
    const name = $('preset-name').value.trim(); if (!name) { $('csv-msg').textContent = 'Give this setup a name first.'; return; }
    try { await api('/api/presets', {method: 'POST', body: JSON.stringify({name, data: currentSetup()})}); $('preset-name').value = ''; await loadPresets(); $('csv-msg').style.color = 'var(--accent)'; $('csv-msg').textContent = `Saved "${name}". Next time a file with the same columns is chosen, it is applied for you.`; } catch (e) { $('csv-msg').textContent = e.message; }
  };
  $('preset-sel').addEventListener('change', () => { const p = presets.find(x => String(x.id) === $('preset-sel').value); if (p) applySetup(JSON.parse(p.data)); });
  $('preset-del').onclick = async () => { const id = $('preset-sel').value; if (id && confirm('Delete this saved setup?')) { await api('/api/presets/' + id, {method: 'DELETE'}); loadPresets(); } };
  // receipts: more than one file, drag and drop, camera
  $('rcp-file').addEventListener('change', () => { const rest = [...$('rcp-file').files].slice(1); if (rest.length) uploadReceipts(rest); });
  $('rcp-cam').addEventListener('change', () => { uploadReceipts($('rcp-cam').files); setTimeout(() => $('rcp-cam').value = '', 500); });
  $('rcp-camera').onclick = () => $('rcp-cam').click();
  const dlg = $('receipt-dialog'); dlg.addEventListener('dragover', ev => { ev.preventDefault(); dlg.classList.add('drop'); }); dlg.addEventListener('dragleave', () => dlg.classList.remove('drop'));
  dlg.addEventListener('drop', ev => { ev.preventDefault(); dlg.classList.remove('drop'); uploadReceipts(ev.dataTransfer.files); });
  // what-if sliders
  $('wi-rows').addEventListener('input', ev => { if (ev.target.dataset.wi !== undefined) wiTotal(); });
  // assets
  $('as-kind').addEventListener('change', asKindToggle); asKindToggle();
  $('as-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    try { await api('/api/assets', {method: 'POST', body: JSON.stringify({name: $('as-name').value, kind: $('as-kind').value, qty: $('as-qty').value, unit: $('as-unit').value, unit_price: $('as-price').value, value: $('as-value').value, as_of: $('as-date').value, note: $('as-note').value})}); $('as-form').reset(); asKindToggle(); $('as-msg').textContent = ''; loadAssets(); }
    catch (e) { $('as-msg').textContent = e.message; }
  });
  $('as-list').addEventListener('click', async ev => {
    const d = ev.target.dataset;
    try {
      if (d.asup) { const v = prompt(d.hasUnit === '1' ? 'New price per unit (for example today\'s gold price per gram):' : 'New value:'); if (v === null || !Number.isFinite(Number(v)) || v.trim() === '') return; await api(`/api/assets/${d.asup}/value`, {method: 'PUT', body: JSON.stringify(d.hasUnit === '1' ? {unit_price: v} : {value: v})}); loadAssets(); }
      if (d.asdel && confirm('Delete this item and its value history?')) { await api('/api/assets/' + d.asdel, {method: 'DELETE'}); loadAssets(); }
    } catch (e) { $('as-msg').textContent = e.message; }
  });
  // low-balance alerts
  $('lb-list').addEventListener('change', async ev => { const id = ev.target.dataset.lb; if (!id) return; try { await api('/api/alerts/balance/' + id, {method: 'PUT', body: JSON.stringify({min_balance: ev.target.value})}); loadReminders(); } catch (e) { showToast(e.message, null); } });
  // claim sheet
  $('claim-go').onclick = buildClaim;
  // health
  $('health-refresh').onclick = loadHealth;
  $('health-list').addEventListener('click', async ev => {
    const a = ev.target.dataset.hact; if (!a) return; const act = JSON.parse(a);
    if (act.rules) { try { const r = await api('/api/rules/apply', {method: 'POST', body: JSON.stringify({all: false})}); showToast(`${r.changed} entr${r.changed === 1 ? 'y' : 'ies'} re-categorized.`, null); loadHealth(); load(); } catch (e) { showToast(e.message, null); } }
    else if (act.tab) { if (act.tab === 'expenses') { $('all-months').checked = true; } goTab(act.tab); if (act.tab === 'expenses') load(); }
  });
  // PIN
  $('pin-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    try { await api('/api/auth/pin/set', {method: 'POST', body: JSON.stringify({current: $('pin-cur').value, pin: $('pin-new').value})}); $('pin-form').reset(); $('pin-msg').style.color = 'var(--accent)'; $('pin-msg').textContent = 'PIN saved.'; loadPinState(); }
    catch (e) { $('pin-msg').style.color = ''; $('pin-msg').textContent = e.message; }
  });
  $('pin-remove').onclick = async () => { try { await api('/api/auth/pin/remove', {method: 'POST', body: JSON.stringify({current: $('pin-cur').value})}); $('pin-form').reset(); $('pin-msg').textContent = 'PIN removed.'; loadPinState(); } catch (e) { $('pin-msg').style.color = ''; $('pin-msg').textContent = e.message; } };
  $('lock-hide').addEventListener('change', () => localStorage.setItem('ledger_lock_on_hide', $('lock-hide').checked ? '1' : '0'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && localStorage.getItem('ledger_lock_on_hide') === '1' && !$('lock-btn').hidden) { fetch('/api/auth/logout', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}', keepalive: true}); window.__relock = true; }
    else if (!document.hidden && window.__relock) location.reload();
  });
  document.addEventListener('keydown', shortcuts);
  $('claim-to').value = today();
  loadPresets(); loadProjectList(); fillBulkAcct();
  bulkInject(); incomeProjectUI();            // the tables were drawn before this started
}
