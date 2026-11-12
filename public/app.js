const $ = id => document.getElementById(id);
const fmt = n => Number(n).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
const fmt0 = n => Number(n).toLocaleString(undefined, {maximumFractionDigits: 0});
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// "Budget month" can start on any day (set on the Budgets tab); these helpers follow that setting.
let periodStartDay = 1;
const curMonth = () => { const d = new Date(); let y = d.getFullYear(), m = d.getMonth() + 1; if (d.getDate() < periodStartDay) { m--; if (!m) { m = 12; y--; } } return `${y}-${String(m).padStart(2, '0')}`; };
const periodStartDate = () => { const [y, m] = curMonth().split('-').map(Number); return new Date(y, m - 1, periodStartDay); };
const daysLeftInPeriod = () => { const s = periodStartDate(), end = new Date(s.getFullYear(), s.getMonth() + 1, periodStartDay), t = new Date(); t.setHours(0, 0, 0, 0); return Math.max(1, Math.round((end - t) / 864e5)); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let monthIncome = 0, incomeRows = [], csvRows = [], expenses = [], allExpenses = [], recurring = [], categories = [];

async function api(url, opts) {
  const r = await fetch(url, opts && {...opts, headers: {'Content-Type': 'application/json'}});
  if (r.status === 401) { showLock(); throw new Error('Please unlock first.'); }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ---------- tabs ---------- */
$('tabs').addEventListener('click', ev => {
  const v = ev.target.dataset.view;
  if (!v) return;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b === ev.target));
  document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== 'view-' + v);
  if (v === 'report') loadReport();
  if (v === 'recurring') loadRecurring();
  if (v === 'income') loadIncome();
  if (v === 'goals') loadGoals();
  if (v === 'accounts') loadAccounts();
  if (v === 'categories') renderCategories();
  if (v === 'backup') { $('restore-msg').textContent = ''; loadAuto(); }
  if (v === 'security') loadSecurity();
  if (v === 'expenses') load();
});

/* ---------- categories ---------- */
async function loadCategories() {
  categories = await api('/api/categories');
  const cur = $('category').value;
  $('cat-list').innerHTML = categories.map(c => `<option value="${esc(c.name)}"></option>`).join('');
  if (cur) $('category').value = cur;
  const fc = $('f-cat').value;
  $('f-cat').innerHTML = '<option value="">All categories</option>' + categories.map(c => `<option>${esc(c.name)}</option>`).join('');
  $('f-cat').value = fc;
}

function renderCategories() {
  $('cat-rows').innerHTML = categories.map(c => `
    <tr>
      <td>${esc(c.name)}</td>
      <td class="num"><input type="number" step="0.01" min="0" placeholder="No limit"
        value="${c.base ?? c.monthly_budget ?? ''}" data-budget="${esc(c.name)}" aria-label="Budget for ${esc(c.name)}"></td>
      <td class="act"><label class="roll" title="Unused budget carries into next month; overspending reduces it"><input type="checkbox" data-roll="${esc(c.name)}" ${c.rollover ? 'checked' : ''}> Roll over${c.carry ? ` (${c.carry > 0 ? '+' : ''}${fmt0(c.carry)} this month)` : ''}</label><button data-rename="${esc(c.name)}">Rename / merge</button><button data-delcat="${esc(c.name)}" class="del">Delete</button></td>
    </tr>`).join('');
}

$('cat-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    await api('/api/categories', {method: 'POST', body: JSON.stringify({name: $('cat-name').value, monthly_budget: $('cat-budget').value})});
    $('cat-form').reset(); $('cat-msg').textContent = '';
    await loadCategories(); renderCategories();
  } catch (e) { $('cat-msg').textContent = e.message; }
});

$('cat-rows').addEventListener('change', async ev => {
  const name = ev.target.dataset.budget;
  if (!name) return;
  try {
    await api('/api/categories/' + encodeURIComponent(name), {method: 'PUT', body: JSON.stringify({monthly_budget: ev.target.value})});
    await loadCategories();
    $('cat-msg').textContent = '';
  } catch (e) { $('cat-msg').textContent = e.message; }
});

$('cat-rows').addEventListener('click', async ev => {
  const name = ev.target.dataset.delcat;
  if (!name || !confirm(`Delete category "${name}"?`)) return;
  try {
    await api('/api/categories/' + encodeURIComponent(name), {method: 'DELETE'});
    await loadCategories(); renderCategories(); $('cat-msg').textContent = '';
  } catch (e) { $('cat-msg').textContent = e.message; }
});

/* ---------- expenses ---------- */
async function load() {
  try {
    expenses = await api('/api/expenses?month=' + $('month').value);
    monthIncome = (await api('/api/income?month=' + $('month').value)).reduce((s, i) => s + Number(i.amount), 0);
    allExpenses = $('all-months').checked ? await api('/api/expenses') : [];
    render();
  } catch (e) { $('msg').textContent = 'Could not load expenses: ' + e.message; }
}

function render() {
  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);
  $('total').textContent = fmt(total);
  $('count').textContent = expenses.length + (expenses.length === 1 ? ' expense' : ' expenses');

  const spent = {};
  expenses.forEach(e => spent[e.category] = (spent[e.category] || 0) + Number(e.amount));
  const budgets = Object.fromEntries(categories.map(c => [c.name, c.monthly_budget == null ? null : Number(c.monthly_budget)]));

  const names = new Set(Object.keys(spent));
  categories.forEach(c => { if (c.monthly_budget != null) names.add(c.name); });
  const list = [...names].map(n => ({n, v: spent[n] || 0, b: budgets[n] ?? null}))
    .sort((a, b) => b.v - a.v);
  const max = Math.max(1, ...list.map(x => x.b ? Math.max(x.v, x.b) : x.v));

  $('bars').innerHTML = list.map(x => {
    const over = x.b != null && x.v > x.b;
    const width = (x.v / max * 100).toFixed(1);
    const val = x.b != null ? `${fmt0(x.v)} <small>/ ${fmt0(x.b)}</small>` : fmt(x.v);
    return `<div class="bar${over ? ' over' : ''}"><span>${esc(x.n)}</span>
      <span class="track"><span class="fill" style="display:block;width:${width}%"></span></span>
      <span class="v">${val}</span></div>`;
  }).join('');

  const totalBudget = categories.reduce((s, c) => s + (Number(c.monthly_budget) || 0), 0);
  const budgeted = categories.filter(c => c.monthly_budget != null).reduce((s, c) => s + (spent[c.name] || 0), 0);
  const overCats = list.filter(x => x.b != null && x.v > x.b).length;
  $('budget-line').textContent = totalBudget
    ? `${fmt0(budgeted)} of ${fmt0(totalBudget)} budgeted` + (overCats ? ` · ${overCats} over budget` : '')
    : '';

  const net = monthIncome - total;
  $('net-line').textContent = monthIncome ? `Income ${fmt(monthIncome)} · Net ${net < 0 ? '−' : '+'}${fmt(Math.abs(net))}` : '';
  $('safe-line').textContent = safeLine(total, totalBudget, budgeted);
  renderAlerts();
  renderTable();
}

function renderTable() {
  const src = $('all-months').checked ? allExpenses : expenses;
  const q = $('q').value.trim().toLowerCase(), cat = $('f-cat').value, tag = $('f-tag').value;
  const list = src.filter(e => (!cat || e.category === cat) && (!tag || (e.tags || '').split(',').includes(tag)) &&
    (!q || (e.title + ' ' + (e.note || '')).toLowerCase().includes(q)));
  const sum = list.reduce((s, e) => s + Number(e.amount), 0);
  const filtered = q || cat || tag || $('all-months').checked;

  $('filter-info').textContent = filtered ? `${list.length} of ${src.length} shown · total ${fmt(sum)}` : '';
  $('rows').innerHTML = list.map(e => `
    <tr>
      <td>${esc(e.spent_on)}</td>
      <td>${esc(e.title)}${e.tags ? `<span class="note">${e.tags.split(',').map(t => '#' + esc(t)).join(' ')}</span>` : ''}${e.note ? `<span class="note">${esc(e.note)}</span>` : ''}</td>
      <td>${esc(e.category)}${e.account_id ? `<span class="note">${esc(acctName(e.account_id))}</span>` : ''}</td>
      <td class="num">${fmt(e.amount)}</td>
      <td class="act"><button data-rcp="${e.id}">Receipts${e.receipts > 0 ? ' (' + e.receipts + ')' : ''}</button><button data-edit="${e.id}">Edit</button><button class="del" data-del="${e.id}">Delete</button></td>
    </tr>`).join('');
  $('empty').hidden = list.length > 0;
  $('empty').textContent = src.length ? 'No expenses match your filters.' : 'No expenses this month. Add your first one above.';
}

$('q').addEventListener('input', renderTable);
$('f-cat').addEventListener('change', renderTable);
$('f-tag').addEventListener('change', renderTable);
$('all-months').addEventListener('change', load);
$('clear-filters').addEventListener('click', () => {
  $('q').value = ''; $('f-cat').value = ''; $('f-tag').value = ''; $('all-months').checked = false; load();
});

function resetForm() {
  $('form').reset();
  $('id').value = '';
  $('spent_on').value = today();
  $('form-title').textContent = 'Add expense';
  $('save').textContent = 'Add expense';
  $('cancel').hidden = true;
  $('msg').textContent = '';
  $('split-rows').innerHTML = ''; $('split-wrap').hidden = false;
}

$('form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const body = {
    spent_on: $('spent_on').value, title: $('title').value, category: $('category').value,
    amount: $('amount').value, note: $('note').value, tags: $('tags').value, account_id: $('account').value || null,
  };
  const id = $('id').value;
  const parts = [...document.querySelectorAll('#split-rows .split-row')].map(r => ({category: r.querySelector('.sp-cat').value, amount: Number(r.querySelector('.sp-amt').value)}));
  try {
    if (parts.length && !id) {
      const rest = Math.round((Number(body.amount) - parts.reduce((s, p) => s + p.amount, 0)) * 100) / 100;
      if (parts.some(p => !(p.amount > 0) || !p.category.trim()) || rest <= 0) { $('msg').textContent = 'Each part must be above 0 and the parts must add up to less than the total.'; return; }
      const post = b => api('/api/expenses', {method: 'POST', body: JSON.stringify(b)});
      await post({...body, amount: rest});
      for (const p of parts) await post({...body, category: p.category, amount: p.amount});
    } else
    await api(id ? '/api/expenses/' + id : '/api/expenses', {method: id ? 'PUT' : 'POST', body: JSON.stringify(body)});
    const m = body.spent_on.slice(0, 7);
    if (m !== $('month').value) $('month').value = m;
    resetForm();
    load(); loadTags(); loadCategories(); loadTitles();
  } catch (e) { $('msg').textContent = e.message; }
});

$('cancel').addEventListener('click', resetForm);

$('rows').addEventListener('click', async ev => {
  const edit = ev.target.dataset.edit, del = ev.target.dataset.del;
  if (ev.target.dataset.rcp) return openReceipts(ev.target.dataset.rcp);
  if (edit) {
    const e = [...expenses, ...allExpenses].find(x => String(x.id) === edit);
    $('id').value = e.id; $('spent_on').value = e.spent_on; $('title').value = e.title;
    $('category').value = e.category; $('amount').value = e.amount; $('note').value = e.note || ''; $('tags').value = e.tags || ''; $('account').value = e.account_id || '';
    $('form-title').textContent = 'Edit expense';
    $('save').textContent = 'Save changes';
    $('cancel').hidden = false; $('split-wrap').hidden = true;
    $('form').scrollIntoView({behavior: 'smooth', block: 'center'});
  }
  if (del) {
    const e0 = [...expenses, ...allExpenses].find(x => String(x.id) === del);
    try {
      await api('/api/expenses/' + del, {method: 'DELETE'}); load(); loadAccounts();
      if (e0) showToast(`Deleted "${e0.title}".`, async () => {
        await api('/api/expenses', {method: 'POST', body: JSON.stringify({spent_on: e0.spent_on, title: e0.title, category: e0.category, amount: e0.amount, note: e0.note, tags: e0.tags, account_id: e0.account_id, restore_from: e0.id})});
        load(); loadAccounts();
      });
    } catch (e) { $('msg').textContent = e.message; }
  }
});

function shiftMonth(d) {
  const [y, m] = $('month').value.split('-').map(Number);
  const dt = new Date(y, m - 1 + d, 1);
  $('month').value = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  load();
}
$('prev').onclick = () => shiftMonth(-1);
$('next').onclick = () => shiftMonth(1);
$('month').addEventListener('change', load);

/* ---------- yearly report ---------- */
async function loadReport() {
  const year = Number($('year').value);
  if (!year) return;
  try {
    const [rows, inc] = await Promise.all([api('/api/report?year=' + year), api('/api/income/by-month?year=' + year)]);
    loadTrends(); loadTopTitles(year); loadCharts(year); $('xl-year').href = '/api/export.xlsx?year=' + year;
    const byCat = {}, byMonth = Array(12).fill(0);
    rows.forEach(r => {
      const t = Number(r.total), m = r.m - 1;
      (byCat[r.category] ||= Array(12).fill(0))[m] += t;
      byMonth[m] += t;
    });
    const total = byMonth.reduce((a, b) => a + b, 0);
    const active = byMonth.filter(v => v > 0).length;
    $('ytotal').textContent = fmt(total);
    $('yavg').textContent = active ? `${fmt(total / active)} average per active month` : 'No expenses this year';

    const max = Math.max(1, ...byMonth);
    $('vbars').innerHTML = byMonth.map((v, i) => `
      <div class="vcol" title="${MONTHS[i]}: ${fmt(v)}">
        <span class="vval">${v ? fmt0(v) : ''}</span>
        <span class="vfill" style="height:${(v / max * 140).toFixed(0)}px"></span>
        <span>${MONTHS[i]}</span>
      </div>`).join('');

    const byInc = Array(12).fill(0);
    inc.forEach(r => byInc[r.m - 1] += Number(r.total));
    const incTotal = byInc.reduce((x, y) => x + y, 0);
    const cats = Object.keys(byCat).sort((a, b) => byCat[b].reduce((x, y) => x + y, 0) - byCat[a].reduce((x, y) => x + y, 0));
    const cell = v => `<td class="num${v ? '' : ' zero'}">${v ? fmt0(v) : '–'}</td>`;
    $('ytable').innerHTML =
      `<thead><tr><th>Category</th>${MONTHS.map(m => `<th class="num">${m}</th>`).join('')}<th class="num">Total</th></tr></thead>
       <tbody>${cats.map(c => `<tr><td>${esc(c)}</td>${byCat[c].map(cell).join('')}<td class="num"><strong>${fmt0(byCat[c].reduce((a, b) => a + b, 0))}</strong></td></tr>`).join('')}</tbody>
       <tfoot><tr><td>Total spent</td>${byMonth.map(cell).join('')}<td class="num">${fmt0(total)}</td></tr>
       <tr><td>Income</td>${byInc.map(cell).join('')}<td class="num">${fmt0(incTotal)}</td></tr>
       <tr><td>Net</td>${byInc.map((v, i) => cell(v - byMonth[i])).join('')}<td class="num">${fmt0(incTotal - total)}</td></tr></tfoot>`;
  } catch (e) { $('yavg').textContent = 'Could not load report: ' + e.message; }
}
$('yprev').onclick = () => { $('year').value = Number($('year').value) - 1; loadReport(); };
$('ynext').onclick = () => { $('year').value = Number($('year').value) + 1; loadReport(); };
$('year').addEventListener('change', loadReport);

/* ---------- budget alerts, live hint, print ---------- */
function monthSpent() {
  const s = {};
  expenses.forEach(e => s[e.category] = (s[e.category] || 0) + Number(e.amount));
  return s;
}

function renderAlerts() {
  const s = monthSpent();
  const items = categories.filter(c => Number(c.monthly_budget) > 0)
    .map(c => ({n: c.name, v: s[c.name] || 0, b: Number(c.monthly_budget)}))
    .filter(x => x.v / x.b >= 0.8).sort((a, b) => b.v / b.b - a.v / a.b);
  $('alerts').innerHTML = items.map(x => x.v > x.b
    ? `<div class="alert over">${esc(x.n)}: over budget by ${fmt(x.v - x.b)} (${fmt0(x.v)} / ${fmt0(x.b)})</div>`
    : `<div class="alert warn">${esc(x.n)}: ${Math.round(x.v / x.b * 100)}% of budget used</div>`).join('') + acctAlerts();
}

function updateHint() {
  const h = $('budget-hint'), cat = $('category').value, amt = Number($('amount').value) || 0;
  const c = categories.find(x => x.name === cat);
  h.textContent = '';
  if (!c || !(Number(c.monthly_budget) > 0) || !amt || $('spent_on').value.slice(0, 7) !== $('month').value) return;
  const editing = $('id').value, b = Number(c.monthly_budget);
  const cur = expenses.filter(e => e.category === cat && String(e.id) !== editing).reduce((s, e) => s + Number(e.amount), 0);
  const pct = Math.round((cur + amt) / b * 100);
  h.textContent = `This would put ${cat} at ${pct}% of its monthly budget (${fmt0(cur + amt)} / ${fmt0(b)}).`;
  h.style.color = pct > 100 ? 'var(--danger)' : '';
}
['input', 'change'].forEach(ev => ['category', 'amount', 'spent_on'].forEach(id => $(id).addEventListener(ev, updateHint)));

$('print-btn').addEventListener('click', () => {
  const s = monthSpent(), total = expenses.reduce((a, e) => a + Number(e.amount), 0);
  const cats = Object.entries(s).sort((a, b) => b[1] - a[1]).map(([n, v]) => {
    const c = categories.find(x => x.name === n);
    return `<tr><td>${esc(n)}</td><td class="num">${fmt(v)}</td><td class="num">${c && c.monthly_budget != null ? fmt(c.monthly_budget) : '–'}</td></tr>`;
  }).join('');
  const list = expenses.slice().sort((a, b) => a.spent_on.localeCompare(b.spent_on)).map(e =>
    `<tr><td>${esc(e.spent_on)}</td><td>${esc(e.title)}${e.note ? ' – ' + esc(e.note) : ''}</td><td>${esc(e.category)}</td><td class="num">${fmt(e.amount)}</td></tr>`).join('');
  $('print-report').innerHTML = `<h1>Expense report – ${esc($('month').value)}</h1>
    <p>Total spent: <strong>${fmt(total)}</strong> across ${expenses.length} expenses.</p>
    <h2>By category</h2><table><thead><tr><th>Category</th><th class="num">Spent</th><th class="num">Budget</th></tr></thead><tbody>${cats}</tbody></table>
    <h2>All expenses</h2><table><thead><tr><th>Date</th><th>Title</th><th>Category</th><th class="num">Amount</th></tr></thead><tbody>${list}</tbody></table>`;
  window.print();
});

/* ---------- income ---------- */
async function loadIncome() {
  try {
    incomeRows = await api('/api/income?month=' + $('inc-month').value);
    $('inc-total').textContent = fmt(incomeRows.reduce((s, i) => s + Number(i.amount), 0));
    $('inc-rows').innerHTML = incomeRows.map(i => `
      <tr><td>${esc(i.received_on)}</td><td>${esc(i.source)}${i.note ? `<span class="note">${esc(i.note)}</span>` : ''}</td>
      <td class="num">${fmt(i.amount)}</td>
      <td class="act"><button data-iedit="${i.id}">Edit</button><button class="del" data-idel="${i.id}">Delete</button></td></tr>`).join('');
    $('inc-empty').hidden = incomeRows.length > 0;
  } catch (e) { $('inc-msg').textContent = e.message; }
}
function resetIncForm() {
  $('inc-form').reset(); $('inc-id').value = ''; $('inc-date').value = today();
  $('inc-title').textContent = 'Add income'; $('inc-save').textContent = 'Add income';
  $('inc-cancel').hidden = true; $('inc-msg').textContent = '';
}
$('inc-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const id = $('inc-id').value;
  const body = {received_on: $('inc-date').value, source: $('inc-source').value, amount: $('inc-amount').value, note: $('inc-note').value, account_id: $('inc-account').value || null};
  try {
    await api(id ? '/api/income/' + id : '/api/income', {method: id ? 'PUT' : 'POST', body: JSON.stringify(body)});
    const m = body.received_on.slice(0, 7);
    if (m !== $('inc-month').value) $('inc-month').value = m;
    resetIncForm(); loadIncome(); loadSources();
  } catch (e) { $('inc-msg').textContent = e.message; }
});
$('inc-cancel').addEventListener('click', resetIncForm);
$('inc-rows').addEventListener('click', async ev => {
  const ed = ev.target.dataset.iedit, del = ev.target.dataset.idel;
  if (ed) {
    const i = incomeRows.find(x => String(x.id) === ed);
    $('inc-id').value = i.id; $('inc-date').value = i.received_on; $('inc-source').value = i.source;
    $('inc-amount').value = i.amount; $('inc-note').value = i.note || ''; $('inc-account').value = i.account_id || '';
    $('inc-title').textContent = 'Edit income'; $('inc-save').textContent = 'Save changes'; $('inc-cancel').hidden = false;
  }
  if (del) {
    const i0 = incomeRows.find(x => String(x.id) === del);
    try {
      await api('/api/income/' + del, {method: 'DELETE'}); loadIncome(); loadAccounts();
      if (i0) showToast(`Deleted income "${i0.source}".`, async () => {
        await api('/api/income', {method: 'POST', body: JSON.stringify({received_on: i0.received_on, source: i0.source, amount: i0.amount, note: i0.note, account_id: i0.account_id})});
        loadIncome(); loadAccounts();
      });
    } catch (e) { $('inc-msg').textContent = e.message; }
  }
});
function shiftInc(d) {
  const [y, m] = $('inc-month').value.split('-').map(Number), dt = new Date(y, m - 1 + d, 1);
  $('inc-month').value = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`; loadIncome();
}
$('iprev').onclick = () => shiftInc(-1); $('inext').onclick = () => shiftInc(1);
$('inc-month').addEventListener('change', loadIncome);

/* ---------- trends ---------- */
function lineChart(months) {
  const W = 700, H = 230, L = 50, R = 10, T = 14, B = 44;
  const max = Math.max(1, ...months.flatMap(m => [m.spent, m.income]));
  const x = i => L + i * (W - L - R) / 11, y = v => T + (H - T - B) * (1 - v / max);
  const pts = k => months.map((m, i) => `${x(i).toFixed(1)},${y(m[k]).toFixed(1)}`).join(' ');
  const grid = [0, .5, 1].map(f => `<line x1="${L}" x2="${W - R}" y1="${y(max * f)}" y2="${y(max * f)}" style="stroke:var(--line)"/><text x="${L - 6}" y="${y(max * f) + 4}" text-anchor="end" style="fill:var(--muted);font-size:11px">${fmt0(max * f)}</text>`).join('');
  const labels = months.map((m, i) => `<text x="${x(i)}" y="${H - B + 16}" text-anchor="middle" style="fill:var(--muted);font-size:11px">${MONTHS[Number(m.ym.slice(5)) - 1]}</text>`).join('');
  const dots = months.map((m, i) => `<circle cx="${x(i)}" cy="${y(m.spent)}" r="3.5" style="fill:var(--bar)"><title>${m.ym}: spent ${fmt(m.spent)}, income ${fmt(m.income)}</title></circle>`).join('');
  const legend = `<g style="font-size:12px;fill:var(--ink)"><line x1="${L}" x2="${L + 22}" y1="${H - 8}" y2="${H - 8}" style="stroke:var(--bar);stroke-width:3"/><text x="${L + 28}" y="${H - 4}">Spent</text><line x1="${L + 90}" x2="${L + 112}" y1="${H - 8}" y2="${H - 8}" style="stroke:var(--ink);stroke-width:2;stroke-dasharray:5 3"/><text x="${L + 118}" y="${H - 4}">Income</text></g>`;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Spending and income, last 12 months">${grid}${labels}<polyline fill="none" points="${pts('income')}" style="stroke:var(--ink);stroke-width:2;stroke-dasharray:5 3"/><polyline fill="none" points="${pts('spent')}" style="stroke:var(--bar);stroke-width:3"/>${dots}${legend}</svg>`;
}
async function loadTrends() {
  try {
    const t = await api('/api/trends?end=' + $('trend-month').value);
    $('trend-chart').innerHTML = lineChart(t.months);
    const rows = t.compare.map(c => ({...c, d: c.cur - c.prev})).sort((p, q) => Math.abs(q.d) - Math.abs(p.d));
    $('trend-table').innerHTML = `<thead><tr><th>Category</th><th class="num">${t.prevYm}</th><th class="num">${t.curYm}</th><th class="num">Change</th></tr></thead><tbody>` +
      rows.map(c => `<tr><td>${esc(c.category)}</td><td class="num">${fmt(c.prev)}</td><td class="num">${fmt(c.cur)}</td><td class="num" style="${c.d > 0 ? 'color:var(--danger)' : ''}">${c.d > 0 ? '+' : c.d < 0 ? '−' : ''}${fmt(Math.abs(c.d))}${c.prev ? ` (${Math.round(Math.abs(c.d) / c.prev * 100)}%)` : ''}</td></tr>`).join('') + '</tbody>';
  } catch (e) { $('trend-chart').textContent = e.message; }
}
$('trend-month').addEventListener('change', loadTrends);

/* ---------- CSV import ---------- */
function parseCSV(t) {
  const rows = []; let r = [], f = '', q = false;
  t = t.replace(/^\uFEFF/, '');
  const endRow = () => { r.push(f); f = ''; if (r.some(c => c.trim())) rows.push(r); r = []; };
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { r.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; endRow(); }
    else f += c;
  }
  if (f || r.length) endRow();
  return rows;
}
function parseDate(s, fmt) {
  const p = String(s).trim().split(/[-/.\s]/)[0] === '' ? [] : String(s).trim().split(/[-/.\sT]/);
  if (p.length < 3) return null;
  let [A, B, C] = p.slice(0, 3).map(Number);
  let y, m, d;
  if (A > 31) { y = A; m = B; d = C; } else if (fmt === 'dmy') { d = A; m = B; y = C; } else if (fmt === 'mdy') { m = A; d = B; y = C; } else { y = A; m = B; d = C; }
  if (y < 100) y += 2000;
  if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
$('csv-file').addEventListener('change', async () => {
  const f = $('csv-file').files[0], msg = $('csv-msg'); msg.style.color = '';
  $('map-form').hidden = true;
  if (!f) return;
  csvRows = parseCSV(await f.text());
  if (csvRows.length < 2) { msg.textContent = 'That file has no data rows.'; return; }
  const head = csvRows[0].map(h => h.trim());
  const opts = '<option value="-1">(none)</option>' + head.map((h, i) => `<option value="${i}">${esc(h || 'Column ' + (i + 1))}</option>`).join('');
  const guess = {date: /date/i, title: /(title|desc|name|memo|payee|detail)/i, amount: /(amount|debit|value|sum)/i, category: /categ/i, note: /note/i, acctcol: /(account|acct)/i};
  for (const k in guess) { $('m-' + k).innerHTML = opts; const i = head.findIndex(h => guess[k].test(h)); $('m-' + k).value = i; }
  $('map-form').hidden = false;
  msg.textContent = `${csvRows.length - 1} rows found. Check the column choices, then press Import.`;
});
function matchAccount(text) {
  const t = String(text || '').trim().toLowerCase(); if (!t) return null;
  const act = accounts.filter(a => !a.archived);
  let m = act.find(a => a.name.toLowerCase() === t) || act.find(a => a.acct_no && t.includes(a.acct_no.toLowerCase()));
  if (!m) { const p = act.filter(a => (a.provider || '').toLowerCase() === t); if (p.length === 1) m = p[0]; }
  return m ? m.id : null;
}
$('map-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const msg = $('csv-msg'), col = k => Number($('m-' + k).value), fmtv = $('m-fmt').value, neg = $('m-sign').value === 'neg', asIncome = neg && $('m-in').value === 'income';
  if (col('date') < 0 || col('title') < 0 || col('amount') < 0) { msg.textContent = 'Choose the date, title and amount columns.'; return; }
  let skipped = 0, matched = 0;
  const rows = [], cell = (r, k) => (col(k) >= 0 ? (r[col(k)] || '').trim() : '');
  csvRows.slice(1).forEach(r => {
    const raw = String(r[col('amount')] ?? '').trim();
    const isNeg = /^\(.*\)$/.test(raw) || raw.includes('-');
    const val = Math.abs(parseFloat(raw.replace(/[^0-9.]/g, '')));
    const date = parseDate(r[col('date')] ?? '', fmtv);
    if (!date || !Number.isFinite(val) || val <= 0) { skipped++; return; }
    const acct = col('acctcol') >= 0 ? matchAccount(r[col('acctcol')]) : null;
    if (acct) matched++;
    const title = cell(r, 'title') || 'Imported';
    if (neg && !isNeg) {
      if (asIncome) rows.push({type: 'income', received_on: date, source: title, amount: val, note: cell(r, 'note'), account_id: acct});
      else skipped++;
      return;
    }
    rows.push({spent_on: date, title, amount: val, category: cell(r, 'category') || 'Other', note: cell(r, 'note'), account_id: acct});
  });
  if (!rows.length) { msg.textContent = `No usable rows (${skipped} skipped). Check the date format and amount column.`; return; }
  if (!confirm(`Import ${rows.length} rows (${rows.filter(x => x.type === 'income').length} as income)?`)) return;
  try {
    const r = await api('/api/import', {method: 'POST', body: JSON.stringify({rows, account_id: $('m-account').value || null})});
    msg.style.color = 'var(--accent)';
    msg.textContent = `Imported ${r.imported} expenses and ${r.income} income entries` + (matched ? ` (${matched} rows matched to an account automatically)` : '') + `. Skipped ${r.duplicates} duplicates and ${skipped + r.invalid} unusable rows.`;
    $('csv-file').value = ''; $('map-form').hidden = true;
    await loadCategories(); await load(); loadAccounts(); loadSources();
  } catch (e) { msg.style.color = ''; msg.textContent = e.message; }
});

/* ---------- undo toast ---------- */
let toastT, toastFn = null;
function showToast(msg, undo) {
  $('toast-msg').textContent = msg; toastFn = undo; $('toast-undo').hidden = !undo; $('toast').hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => $('toast').hidden = true, 10000);
}
$('toast-undo').addEventListener('click', async () => {
  $('toast').hidden = true; const f = toastFn; toastFn = null;
  try { if (f) { await f(); showToast('Restored.', null); } } catch (e) { showToast('Could not undo: ' + e.message, null); }
});

/* ---------- reminders ---------- */
async function loadReminders() {
  try {
    const r = await api('/api/recurring/upcoming');
    $('reminders').innerHTML = r.map(x => `<div class="alert warn">${esc(x.title)} (${fmt(x.amount)}${x.kind === 'income' ? ' income' : ''}) is due in ${x.days} day${x.days > 1 ? 's' : ''}, on ${x.date}.</div>`).join('') + cardDue();
  } catch {}
}

/* ---------- split expenses ---------- */
$('split-add').onclick = () => {
  const d = document.createElement('div'); d.className = 'split-row';
  d.innerHTML = `<input type="text" class="sp-cat" list="cat-list" placeholder="Category" aria-label="Part category" autocomplete="off"><input type="number" class="sp-amt" step="0.01" min="0.01" placeholder="Part amount" aria-label="Part amount"><button type="button" class="del">Remove</button>`;
  d.querySelector('button').onclick = () => d.remove();
  $('split-rows').append(d);
};

/* ---------- encrypted backup ---------- */
$('enc-btn').addEventListener('click', async () => {
  const msg = $('enc-msg'); msg.style.color = '';
  const p = $('enc-pass').value;
  if (p.length < 8) { msg.textContent = 'Passphrase must be at least 8 characters.'; return; }
  try {
    const r = await fetch('/api/backup/encrypted', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({passphrase: p})});
    if (r.status === 401) { showLock(); return; }
    const d = await r.json(); if (!r.ok) throw new Error(d.error);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(d)], {type: 'application/json'}));
    a.download = `expense-tracker-backup-${today()}.encrypted.json`; a.click(); URL.revokeObjectURL(a.href);
    $('enc-pass').value = '';
    msg.style.color = 'var(--accent)'; msg.textContent = 'Downloaded. Keep the passphrase safe: it cannot be recovered.';
  } catch (e) { msg.textContent = e.message; }
});

/* ---------- automatic backup encryption ---------- */
async function loadAuto() {
  try {
    const s = await api('/api/backup/auto');
    $('auto-state').textContent = s.enabled ? 'Encryption is ON. New daily copies are saved as encrypted .enc.json files.' : 'Encryption is OFF. Daily copies are plain files.';
    $('auto-on').textContent = s.enabled ? 'Change passphrase' : 'Turn on encryption';
    $('auto-off').hidden = !s.enabled;
  } catch {}
}
$('auto-on').addEventListener('click', async () => {
  const msg = $('auto-msg'); msg.style.color = '';
  try {
    const r = await api('/api/backup/auto', {method: 'POST', body: JSON.stringify({passphrase: $('auto-pass').value})});
    $('auto-pass').value = '';
    msg.style.color = 'var(--accent)'; msg.textContent = `Encryption is on${r.converted ? ` (${r.converted} existing copies encrypted)` : ''}. Keep the passphrase safe: it cannot be recovered.`;
    loadAuto();
  } catch (e) { msg.textContent = e.message; }
});
$('auto-off').addEventListener('click', async () => {
  if (!confirm('Turn encryption off? New daily copies will be plain files. Old encrypted copies stay encrypted.')) return;
  try { await api('/api/backup/auto', {method: 'POST', body: JSON.stringify({enabled: false})}); $('auto-msg').textContent = ''; loadAuto(); }
  catch (e) { $('auto-msg').textContent = e.message; }
});

/* ---------- saved titles: type-ahead + auto-fill ---------- */
let titles = [];
async function loadTitles() {
  try {
    titles = await api('/api/titles');
    $('title-list').innerHTML = titles.map(t => `<option value="${esc(t.title)}" label="${esc(t.category)} · ${fmt(t.amount)}"></option>`).join('');
  } catch {}
}
function autofillFromTitle() {
  if ($('id').value) return;                       // never overwrite while editing
  const t = titles.find(x => x.title.toLowerCase() === $('title').value.trim().toLowerCase());
  if (!t) return;
  if (!$('category').value) $('category').value = t.category;
  if (!$('amount').value) $('amount').value = t.amount;
  if (!$('tags').value && t.tags) $('tags').value = t.tags;
  updateHint();
}
$('title').addEventListener('change', autofillFromTitle);
$('title').addEventListener('input', ev => { if (!ev.inputType || ev.inputType === 'insertReplacementText') autofillFromTitle(); });

/* ---------- income sources, rename/merge categories, top titles ---------- */
let sources = [];
async function loadSources() {
  try {
    sources = await api('/api/sources');
    $('source-list').innerHTML = sources.map(x => `<option value="${esc(x.source)}" label="${fmt(x.amount)}"></option>`).join('');
  } catch {}
}
function fillFromSource() {
  if ($('inc-id').value) return;
  const x = sources.find(s => s.source.toLowerCase() === $('inc-source').value.trim().toLowerCase());
  if (x && !$('inc-amount').value) $('inc-amount').value = x.amount;
}
$('inc-source').addEventListener('change', fillFromSource);
$('inc-source').addEventListener('input', ev => { if (!ev.inputType || ev.inputType === 'insertReplacementText') fillFromSource(); });

$('cat-rows').addEventListener('click', async ev => {
  const from = ev.target.dataset.rename;
  if (!from) return;
  const to = prompt(`New name for "${from}".\nIf that name already exists, the two categories are merged.`, from);
  if (!to || !to.trim() || to.trim() === from) return;
  try {
    const r = await api(`/api/categories/${encodeURIComponent(from)}/rename`, {method: 'PUT', body: JSON.stringify({to})});
    $('cat-msg').style.color = 'var(--accent)';
    $('cat-msg').textContent = `${r.merged ? 'Merged into' : 'Renamed to'} "${r.name}" (${r.expenses} expenses updated).`;
    await loadCategories(); renderCategories(); loadTitles();
  } catch (e) { $('cat-msg').style.color = ''; $('cat-msg').textContent = e.message; }
});

async function loadTopTitles(year) {
  try {
    const t = await api('/api/top-titles?year=' + year);
    $('top-table').innerHTML = '<thead><tr><th>Title</th><th class="num">Times</th><th class="num">Average</th><th class="num">Total</th></tr></thead><tbody>' +
      (t.map(r => `<tr><td>${esc(r.title)}</td><td class="num">${r.n}</td><td class="num">${fmt(r.avg)}</td><td class="num"><strong>${fmt(r.total)}</strong></td></tr>`).join('') || '<tr><td colspan="4">No expenses this year.</td></tr>') + '</tbody>';
  } catch (e) { $('top-table').innerHTML = `<tbody><tr><td>${esc(e.message)}</td></tr></tbody>`; }
}

/* ---------- tags ---------- */
async function loadTags() {
  try {
    const t = await api('/api/tags'), cur = $('f-tag').value;
    $('f-tag').innerHTML = '<option value="">All tags</option>' + t.map(x => `<option value="${esc(x.tag)}">#${esc(x.tag)} (${x.count})</option>`).join('');
    $('f-tag').value = cur;
  } catch {}
}

/* ---------- receipts ---------- */
let rcpId = null;
async function openReceipts(id) {
  rcpId = id; $('rcp-msg').textContent = '';
  const list = await api(`/api/expenses/${id}/receipts`);
  $('rcp-list').innerHTML = list.map(r => `<li><a href="/api/receipts/${r.id}" target="_blank" rel="noopener">${esc(r.filename)}</a> <small>${Math.max(1, Math.round(r.size / 1024))} KB</small> <button class="del" data-delr="${r.id}">Delete</button></li>`).join('') || '<li class="count">No receipts yet.</li>';
  if (!$('receipt-dialog').open) $('receipt-dialog').showModal();
}
$('rcp-close').onclick = () => { $('receipt-dialog').close(); load(); };
$('rcp-list').addEventListener('click', async ev => {
  const d = ev.target.dataset.delr;
  if (d && confirm('Delete this receipt?')) { await api('/api/receipts/' + d, {method: 'DELETE'}); openReceipts(rcpId); }
});
$('rcp-file').addEventListener('change', async () => {
  const f = $('rcp-file').files[0]; if (!f) return;
  try {
    const r = await fetch(`/api/expenses/${rcpId}/receipts`, {method: 'POST', headers: {'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name)}, body: f});
    if (r.status === 401) { showLock(); return; }
    const d = await r.json(); if (!r.ok) throw new Error(d.error);
    $('rcp-file').value = ''; openReceipts(rcpId);
  } catch (e) { $('rcp-msg').textContent = e.message; }
});

/* ---------- goals ---------- */
async function loadGoals() {
  try {
    const g = await api('/api/goals');
    $('goal-list').innerHTML = g.map(x => {
      const saved = Number(x.saved), t = Number(x.target), pct = Math.min(100, Math.round(saved / t * 100));
      let need = '';
      if (x.deadline && saved < t) { const mo = Math.max(1, Math.ceil((new Date(x.deadline) - new Date()) / 2629800000)); need = ` · save ${fmt((t - saved) / mo)} per month to finish by ${x.deadline}`; }
      return `<div class="goal"><div class="goal-top"><strong>${esc(x.name)}</strong><span>${fmt(saved)} / ${fmt(t)} (${pct}%)</span></div>
        <div class="bar" style="grid-template-columns:1fr"><span class="track"><span class="fill" style="display:block;width:${pct}%"></span></span></div>
        <p class="count">${saved >= t ? 'Goal reached.' : fmt(t - saved) + ' to go'}${need}</p>
        <div class="goal-act"><input type="number" step="0.01" min="0.01" placeholder="Amount" aria-label="Amount for ${esc(x.name)}" data-amt="${x.id}">
        <button data-dep="${x.id}">Add</button><button data-wd="${x.id}">Withdraw</button><button class="del" data-delg="${x.id}">Delete</button></div></div>`;
    }).join('') || '<p class="empty">No goals yet.</p>';
  } catch (e) { $('goal-msg').textContent = e.message; }
}
$('goal-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    await api('/api/goals', {method: 'POST', body: JSON.stringify({name: $('goal-name').value, target: $('goal-target').value, deadline: $('goal-date').value})});
    $('goal-form').reset(); $('goal-msg').textContent = ''; loadGoals();
  } catch (e) { $('goal-msg').textContent = e.message; }
});
$('goal-list').addEventListener('click', async ev => {
  const d = ev.target.dataset, box = id => document.querySelector(`[data-amt="${id}"]`);
  try {
    if (d.dep || d.wd) {
      const id = d.dep || d.wd, v = Number(box(id).value);
      await api(`/api/goals/${id}/deposit`, {method: 'POST', body: JSON.stringify({amount: d.dep ? v : -v})}); loadGoals();
    }
    if (d.delg && confirm('Delete this goal and its history?')) { await api('/api/goals/' + d.delg, {method: 'DELETE'}); loadGoals(); }
  } catch (e) { $('goal-msg').textContent = e.message; }
});

/* ---------- idle auto-lock ---------- */
let idleT;
function armIdle() {
  clearTimeout(idleT);
  if ($('lock-btn').hidden) return;
  idleT = setTimeout(async () => {
    await fetch('/api/auth/logout', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
    location.reload();
  }, 15 * 60 * 1000);
}
['click', 'keydown', 'mousemove', 'touchstart'].forEach(ev => document.addEventListener(ev, armIdle, {passive: true}));

/* ---------- accounts: banks / mobile wallets / credit cards / cash ---------- */
let accounts = [], transfers = [];
const TYPE_NAME = {bank: 'Bank', card: 'Credit card', mfs: 'Mobile wallet', cash: 'Cash'};
const acctLabel = a => a.name + (a.acct_no && !a.name.includes(a.acct_no) ? ' ••' + a.acct_no : '');
const acctName = id => { const a = accounts.find(x => String(x.id) === String(id)); return a ? acctLabel(a) : ''; };
async function loadAccounts() {
  try {
    accounts = await api('/api/accounts');
    const act = accounts.filter(a => !a.archived);
    const opts = act.map(a => `<option value="${a.id}">${esc(acctLabel(a))}</option>`).join('');
    ['account', 'inc-account', 'rec-account', 'm-account'].forEach(id => { const cur = $(id).value; $(id).innerHTML = '<option value="">No account</option>' + opts; $(id).value = cur; });
    ['tr-from', 'tr-to', 'st-acct'].forEach(id => { const cur = $(id).value; $(id).innerHTML = opts; $(id).value = cur; });
    if (act.length > 1 && $('tr-from').value === $('tr-to').value) $('tr-to').selectedIndex = 1;
    renderAccounts(); loadTransfers(); renderAlerts();
    if (!$('view-accounts').hidden) loadNetWorth();
  } catch {}
}
function accountCard(a) {
  const bal = Number(a.balance), sub = [a.provider, a.acct_no ? '••' + a.acct_no : ''].filter(Boolean).join(' · ');
  let main, extra = '';
  if (a.type === 'card') {
    const o = -bal, lim = a.credit_limit == null ? null : Number(a.credit_limit);
    main = o >= 0 ? `Owed ${fmt(o)}` : `Credit ${fmt(-o)}`;
    if (lim) { const pct = Math.max(0, Math.min(100, Math.round(o / lim * 100))); extra = `<div class="bar" style="grid-template-columns:1fr"><span class="track"><span class="fill" style="display:block;width:${pct}%;${pct >= 80 ? 'background:var(--danger)' : ''}"></span></span></div><p class="count">Limit ${fmt(lim)} · Available ${fmt(lim - o)} · ${pct}% used${a.due_day ? ` · Payment due on day ${a.due_day}` : ''}</p>`; }
    else if (a.due_day) extra = `<p class="count">Payment due on day ${a.due_day}</p>`;
  } else main = fmt(bal);
  if (Number(a.monthly_limit) > 0) {
    const ml = Number(a.monthly_limit), sp = Number(a.month_spent), p = Math.min(100, Math.round(sp / ml * 100));
    extra += `<div class="bar" style="grid-template-columns:1fr"><span class="track"><span class="fill" style="display:block;width:${p}%;${sp > ml ? 'background:var(--danger)' : ''}"></span></span></div><p class="count">Spending this month: ${fmt(sp)} of ${fmt(ml)} limit${sp > ml ? ' (over by ' + fmt(sp - ml) + ')' : ''}</p>`;
  }
  if (a.reconciled_on) extra += `<p class="count">Last checked against the real balance: ${esc(a.reconciled_on)}</p>`;
  const btn = a.archived ? `<button data-unarch="${a.id}">Restore</button>` :
    `<button data-stmt="${a.id}">Statement</button><button data-recon="${a.id}">Reconcile</button><button data-editacct="${a.id}">Edit</button><button class="del" data-delacct="${a.id}">Delete</button>`;
  return `<div class="goal"><div class="goal-top"><strong>${esc(a.name)} <small class="count">${TYPE_NAME[a.type] || ''}${sub ? ' · ' + esc(sub) : ''}</small></strong><span>${main}</span></div>${extra}<div class="goal-act">${btn}</div></div>`;
}
function renderAccounts() {
  const act = accounts.filter(a => !a.archived), arch = accounts.filter(a => a.archived);
  const assets = act.filter(a => a.type !== 'card').reduce((s, a) => s + Number(a.balance), 0);
  const owed = act.filter(a => a.type === 'card').reduce((s, a) => s - Number(a.balance), 0);
  $('acct-net').textContent = act.length ? `In banks, wallets and cash: ${fmt(assets)} · Owed on cards: ${fmt(owed)} · Net: ${fmt(assets - owed)}` : '';
  $('acct-list').innerHTML = act.map(accountCard).join('') || '<p class="empty">No accounts yet. Add your banks, bKash, Nagad or credit cards below.</p>';
  $('arch-wrap').hidden = !arch.length; $('acct-archived').innerHTML = arch.map(accountCard).join('');
}
function acctAlerts() {
  return accounts.filter(a => !a.archived && Number(a.monthly_limit) > 0).map(a => ({a, p: Number(a.month_spent) / Number(a.monthly_limit)})).filter(x => x.p >= 0.8)
    .map(x => x.p > 1 ? `<div class="alert over">${esc(x.a.name)}: over its monthly limit by ${fmt(x.a.month_spent - x.a.monthly_limit)}</div>` : `<div class="alert warn">${esc(x.a.name)}: ${Math.round(x.p * 100)}% of its monthly limit used</div>`).join('');
}
function netChart(m) {
  const W = 700, H = 230, L = 62, R = 10, T = 14, B = 44, vals = m.flatMap(p => [p.net, p.assets]);
  const lo = Math.min(0, ...vals), hi = Math.max(1, ...vals), span = hi - lo || 1;
  const x = i => L + i * (W - L - R) / (m.length - 1), y = v => T + (H - T - B) * (1 - (v - lo) / span);
  const pts = k => m.map((p, i) => `${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  const grid = [lo, lo + span / 2, hi].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" style="fill:var(--muted);font-size:11px">${fmt0(v)}</text>`).join('');
  const labels = m.map((p, i) => `<text x="${x(i)}" y="${H - B + 16}" text-anchor="middle" style="fill:var(--muted);font-size:11px">${MONTHS[Number(p.ym.slice(5)) - 1]}</text>`).join('');
  const dots = m.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.net)}" r="3.5" style="fill:var(--bar)"><title>${p.ym}: net ${fmt(p.net)} (in accounts ${fmt(p.assets)}, owed on cards ${fmt(p.owed)})</title></circle>`).join('');
  const legend = `<g style="font-size:12px;fill:var(--ink)"><line x1="${L}" x2="${L + 22}" y1="${H - 8}" y2="${H - 8}" style="stroke:var(--bar);stroke-width:3"/><text x="${L + 28}" y="${H - 4}">Net worth</text><line x1="${L + 110}" x2="${L + 132}" y1="${H - 8}" y2="${H - 8}" style="stroke:var(--ink);stroke-width:2;stroke-dasharray:5 3"/><text x="${L + 138}" y="${H - 4}">Money in banks, wallets, cash</text></g>`;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Net worth over the last 12 months">${grid}${labels}<polyline fill="none" points="${pts('assets')}" style="stroke:var(--ink);stroke-width:2;stroke-dasharray:5 3"/><polyline fill="none" points="${pts('net')}" style="stroke:var(--bar);stroke-width:3"/>${dots}${legend}</svg>`;
}
async function loadNetWorth() {
  try { $('nw-chart').innerHTML = accounts.some(a => !a.archived) ? netChart(await api('/api/networth')) : '<p class="empty">Add accounts to see your net worth over time.</p>'; } catch {}
}
function cardDue() {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return accounts.filter(a => !a.archived && a.type === 'card' && a.due_day && Number(a.balance) < 0).map(a => {
    for (const off of [0, 1]) {
      const first = new Date(t.getFullYear(), t.getMonth() + off, 1), last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      const d = new Date(first.getFullYear(), first.getMonth(), Math.min(a.due_day, last)), days = Math.round((d - t) / 864e5);
      if (days >= 0 && days <= 5) return `<div class="alert warn">${esc(a.name)} card payment ${days === 0 ? 'is due today' : 'is due in ' + days + ' day' + (days > 1 ? 's' : '')}. Owed: ${fmt(-Number(a.balance))}.</div>`;
    }
    return '';
  }).join('');
}
function accTypeToggle() {
  const t = $('acc-type').value, card = t === 'card';
  $('acc-limit-wrap').hidden = !card; $('acc-due-wrap').hidden = !card;
  $('acc-prov-wrap').hidden = t === 'cash';
  $('acc-provider').setAttribute('list', t === 'mfs' ? 'mfs-list' : 'bank-list');
  $('acc-prov-label').textContent = t === 'mfs' ? 'Wallet / MFS name' : card ? 'Card issuing bank' : 'Bank name';
  $('acc-open-label').textContent = card ? 'Amount owed when you start tracking' : 'Starting balance';
}
function resetAcctForm() {
  $('acct-form').reset(); $('acc-id').value = ''; accTypeToggle();
  $('acc-title').textContent = 'Add account'; $('acc-save').textContent = 'Add account'; $('acc-cancel').hidden = true; $('acct-msg').textContent = '';
}
$('acc-type').addEventListener('change', accTypeToggle);
$('acc-cancel').onclick = resetAcctForm;
$('acct-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const id = $('acc-id').value;
  const body = {type: $('acc-type').value, provider: $('acc-provider').value, acct_no: $('acc-no').value, name: $('acc-name').value, opening_balance: $('acc-open').value, credit_limit: $('acc-limit').value, due_day: $('acc-due').value, monthly_limit: $('acc-mlimit').value};
  try { await api(id ? '/api/accounts/' + id : '/api/accounts', {method: id ? 'PUT' : 'POST', body: JSON.stringify(body)}); resetAcctForm(); loadAccounts(); }
  catch (e) { $('acct-msg').textContent = e.message; }
});
async function accountClick(ev) {
  const d = ev.target.dataset, find = id => accounts.find(x => String(x.id) === String(id));
  try {
    if (d.editacct) {
      const a = find(d.editacct), card = a.type === 'card';
      $('acc-id').value = a.id; $('acc-type').value = a.type; accTypeToggle();
      $('acc-provider').value = a.provider || ''; $('acc-no').value = a.acct_no || ''; $('acc-name').value = a.name;
      $('acc-open').value = card ? -Number(a.opening_balance) : Number(a.opening_balance); $('acc-limit').value = a.credit_limit ?? ''; $('acc-due').value = a.due_day ?? ''; $('acc-mlimit').value = a.monthly_limit ?? '';
      $('acc-title').textContent = 'Edit account'; $('acc-save').textContent = 'Save changes'; $('acc-cancel').hidden = false;
      $('acct-form').scrollIntoView({behavior: 'smooth', block: 'center'});
    }
    if (d.delacct) {
      const r = await api('/api/accounts/' + d.delacct, {method: 'DELETE'});
      if (r.archived) showToast(`Archived (it has ${r.entries} entries). Find it under "Archived accounts".`, null);
      loadAccounts();
    }
    if (d.unarch) { await api(`/api/accounts/${d.unarch}/archive`, {method: 'PUT', body: JSON.stringify({archived: false})}); loadAccounts(); }
    if (d.stmt) { $('st-acct').value = d.stmt; $('statement').scrollIntoView({behavior: 'smooth'}); showStatement(); }
    if (d.recon) {
      const a = find(d.recon), card = a.type === 'card';
      const v = prompt(card ? `Enter the amount you really owe on "${a.name}" (see your card statement/app):` : `Enter the real balance of "${a.name}" (see your bank/wallet app):`);
      if (v === null || v.trim() === '' || !Number.isFinite(Number(v))) return;
      const actual = card ? -Number(v) : Number(v), diff = Math.round((actual - Number(a.balance)) * 100) / 100;
      if (!diff) { showToast('Matches the app. Nothing to fix.', null); return; }
      if (!confirm(`The app shows ${fmt(card ? -a.balance : a.balance)}, you entered ${fmt(Number(v))}. Difference: ${fmt(Math.abs(diff))}.\nAdjust the account to match your real balance?`)) return;
      await api(`/api/accounts/${a.id}/reconcile`, {method: 'POST', body: JSON.stringify({actual})}); loadAccounts();
    }
  } catch (e) { $('acct-msg').textContent = e.message; }
}
$('acct-list').addEventListener('click', accountClick); $('acct-archived').addEventListener('click', accountClick);

async function showStatement() {
  const id = $('st-acct').value; if (!id) return;
  try {
    const s = await api(`/api/accounts/${id}/statement?month=${$('st-month').value}`), card = s.account.type === 'card';
    const bal = v => card ? (v <= 0 ? 'Owed ' + fmt(-v) : 'Credit ' + fmt(v)) : fmt(v);
    $('st-table').innerHTML = `<thead><tr><th>Date</th><th>Details</th><th class="num">Money in</th><th class="num">Money out</th><th class="num">Balance</th></tr></thead><tbody>
      <tr><td colspan="4"><em>Opening balance</em></td><td class="num">${bal(s.opening)}</td></tr>` +
      s.rows.map(r => `<tr><td>${esc(r.date)}</td><td>${esc(r.label)}</td><td class="num">${r.delta > 0 ? fmt(r.delta) : ''}</td><td class="num">${r.delta < 0 ? fmt(-r.delta) : ''}</td><td class="num">${bal(r.balance)}</td></tr>`).join('') +
      `<tr><td colspan="4"><strong>Closing balance</strong></td><td class="num"><strong>${bal(s.closing)}</strong></td></tr></tbody>`;
    $('st-table').dataset.title = `${s.account.name} statement ${$('st-month').value}`;
  } catch (e) { $('st-table').innerHTML = `<tbody><tr><td>${esc(e.message)}</td></tr></tbody>`; }
}
$('st-show').onclick = showStatement;
$('st-print').onclick = () => { $('print-report').innerHTML = `<h1>${esc($('st-table').dataset.title || 'Statement')}</h1><table>${$('st-table').innerHTML}</table>`; window.print(); };

async function loadTransfers() {
  try {
    transfers = await api('/api/transfers');
    $('tr-rows').innerHTML = transfers.map(t => `<tr><td>${esc(t.moved_on)}</td><td>${esc(t.from_name)} → ${esc(t.to_name)}${t.note ? `<span class="note">${esc(t.note)}</span>` : ''}</td><td class="num">${fmt(t.amount)}</td><td class="num">${Number(t.fee) ? fmt(t.fee) : '–'}</td><td class="act"><button class="del" data-deltr="${t.id}">Delete</button></td></tr>`).join('');
  } catch {}
}
$('tr-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    await api('/api/transfers', {method: 'POST', body: JSON.stringify({moved_on: $('tr-date').value, from_id: $('tr-from').value, to_id: $('tr-to').value, amount: $('tr-amount').value, fee: $('tr-fee').value, note: $('tr-note').value})});
    $('tr-amount').value = ''; $('tr-fee').value = 0; $('tr-note').value = ''; $('tr-msg').textContent = ''; loadAccounts(); load();
  } catch (e) { $('tr-msg').textContent = e.message; }
});
$('tr-rows').addEventListener('click', async ev => {
  const id = ev.target.dataset.deltr; if (!id) return;
  const t = transfers.find(x => String(x.id) === id);
  try {
    await api('/api/transfers/' + id, {method: 'DELETE'}); loadAccounts(); load();
    if (t) showToast('Transfer deleted.', async () => {
      await api('/api/transfers', {method: 'POST', body: JSON.stringify({moved_on: t.moved_on, from_id: t.from_id, to_id: t.to_id, amount: t.amount, fee: t.fee, note: t.note})}); loadAccounts(); load();
    });
  } catch (e) { $('tr-msg').textContent = e.message; }
});

/* ---------- month-end summary ---------- */
async function showSummary(ym, auto) {
  const [y, m] = ym.split('-').map(Number);
  const [exp, inc, t] = await Promise.all([api('/api/expenses?month=' + ym), api('/api/income?month=' + ym), api('/api/trends?end=' + ym)]);
  if (auto && !exp.length && !inc.length) return;
  const spent = exp.reduce((s, e) => s + Number(e.amount), 0), income = inc.reduce((s, i) => s + Number(i.amount), 0), net = income - spent;
  const prev = t.months[10].spent, byCat = {}, byTitle = {};
  exp.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount); const k = e.title.toLowerCase(); (byTitle[k] ||= {t: e.title, v: 0, n: 0}).v += Number(e.amount); byTitle[k].n++; });
  const bud = Object.fromEntries(categories.map(c => [c.name, c.monthly_budget == null ? null : Number(c.monthly_budget)]));
  const names = new Set([...Object.keys(byCat), ...categories.filter(c => c.monthly_budget != null).map(c => c.name)]);
  const rows = [...names].map(n => ({n, v: byCat[n] || 0, b: bud[n] ?? null})).sort((p, q) => q.v - p.v).map(x => {
    const st = x.b == null ? '–' : x.v > x.b ? `<span style="color:var(--danger)">Over by ${fmt(x.v - x.b)}</span>` : `Under by ${fmt(x.b - x.v)}`;
    return `<tr><td>${esc(x.n)}</td><td class="num">${fmt(x.v)}</td><td class="num">${x.b == null ? '–' : fmt(x.b)}</td><td>${st}</td></tr>`;
  }).join('');
  const top = Object.values(byTitle).sort((p, q) => q.v - p.v).slice(0, 5).map(x => `<tr><td>${esc(x.t)}</td><td class="num">${x.n}</td><td class="num">${fmt(x.v)}</td></tr>`).join('');
  const big = exp.slice().sort((p, q) => q.amount - p.amount)[0];
  const diff = prev ? Math.round((spent - prev) / prev * 100) : null;
  $('sum-body').innerHTML = `<h1>${MONTHS[m - 1]} ${y} summary</h1>
    <p>Income <strong>${fmt(income)}</strong> · Spent <strong>${fmt(spent)}</strong> · Net <strong>${net < 0 ? '−' : '+'}${fmt(Math.abs(net))}</strong>${income > 0 ? ` (${Math.round(net / income * 100)}% of income)` : ''}</p>
    <p>${diff === null ? 'No spending in the previous month to compare.' : `Spending was ${Math.abs(diff)}% ${diff > 0 ? 'higher' : 'lower'} than the month before (${fmt(prev)}).`}${big ? ` Biggest expense: ${esc(big.title)} (${fmt(big.amount)}).` : ''}</p>
    <h2>Budgets</h2><table><thead><tr><th>Category</th><th class="num">Spent</th><th class="num">Budget</th><th>Result</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No spending.</td></tr>'}</tbody></table>
    <h2>Top titles</h2><table><thead><tr><th>Title</th><th class="num">Times</th><th class="num">Total</th></tr></thead><tbody>${top || '<tr><td colspan="3">None.</td></tr>'}</tbody></table>`;
  $('sum-dialog').showModal();
}
$('sum-btn').addEventListener('click', () => showSummary($('month').value).catch(e => $('msg').textContent = e.message));
$('sum-close').onclick = () => $('sum-dialog').close();
$('sum-print').onclick = () => { $('print-report').innerHTML = $('sum-body').innerHTML; window.print(); };
function autoSummary() {
  try {
    const now = new Date();
    if ((now - periodStartDate()) / 864e5 >= 7) return;   // only in the first week of a new budget month
    const [cy, cm] = curMonth().split('-').map(Number), p = new Date(cy, cm - 2, 1), ym = `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}`;
    if (localStorage.getItem('ledger_summary') === ym) return;
    localStorage.setItem('ledger_summary', ym);
    showSummary(ym, true).catch(() => {});
  } catch {}
}

/* ---------- safe to spend today ---------- */
function safeLine(total, totalBudget, budgetedSpent) {
  if ($('month').value !== curMonth()) return '';
  const left = daysLeftInPeriod();
  let remaining, basis;
  if (totalBudget > 0) { remaining = totalBudget - budgetedSpent; basis = 'budgets'; }
  else if (monthIncome > 0) { remaining = monthIncome - total; basis = 'income'; }
  else return '';
  if (remaining <= 0) return `Nothing left from your ${basis} this month (over by ${fmt(-remaining)}).`;
  return `Safe to spend today: ${fmt(remaining / left)}  (${fmt(remaining)} left over ${left} day${left > 1 ? 's' : ''}, based on your ${basis})`;
}

/* ---------- paste a payment SMS ---------- */
function parseSms(text, todayStr, accts) {
  const t = String(text).replace(/\s+/g, ' ').trim(), low = t.toLowerCase(), o = {amount: null, fee: 0, trx: '', date: todayStr, kind: 'expense', title: '', provider: '', accountId: null};
  for (const m of t.matchAll(/(?:tk\.?|bdt|৳)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:tk|bdt|taka)\b/gi)) {
    if (/fee|charge|balance|\bbal\b|vat/.test(t.slice(Math.max(0, m.index - 14), m.index).toLowerCase())) continue;
    o.amount = Number((m[1] || m[2]).replace(/,/g, '')); break;
  }
  const fee = /(?:fee|charge)s?\s*:?\s*(?:tk\.?|bdt|৳)?\s*([\d,]+(?:\.\d{1,2})?)/i.exec(t); if (fee) o.fee = Number(fee[1].replace(/,/g, '')) || 0;
  const trx = /(?:trx\s?id|txn\s?id|transaction\s?(?:id|no)|trans\s?id)\s*[:\-]?\s*([A-Za-z0-9]{6,})/i.exec(t); if (trx) o.trx = trx[1];
  const MON = {jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12};
  let dm = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(t), dd, mm, yy;
  if (dm) { dd = +dm[1]; mm = +dm[2]; yy = +dm[3]; }
  else if ((dm = /(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s,]*(\d{2,4})/.exec(t)) && MON[dm[2].toLowerCase()]) { dd = +dm[1]; mm = MON[dm[2].toLowerCase()]; yy = +dm[3]; }
  if (dd && yy < 100) yy += 2000;
  if (dd && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && yy > 2000) o.date = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  if (/(received|credited|cash in|refund|deposit)/.test(low) && !/(paid|debited|cash out|withdraw|\bsent\b)/.test(low)) o.kind = 'income';
  for (const [k, n] of [['bkash', 'bKash'], ['nagad', 'Nagad'], ['rocket', 'Rocket'], ['upay', 'Upay'], ['surecash', 'SureCash'], ['mcash', 'mCash']]) if (low.includes(k)) { o.provider = n; break; }
  const stop = '(?=\\s+(?:fee|balance|trx|txn|on|at|ref|successful|has|for)\\b|[.,;]|$)';
  const grab = re => { const m = re.exec(t); return m ? m[1].trim() : ''; };
  let who = grab(new RegExp('\\b(?:paid|payment)\\b.*?\\bto\\s+([^.,;:]+?)' + stop, 'i')) || grab(new RegExp('merchant\\s*[:\\-]?\\s*([^.,;:]+?)' + stop, 'i'))
    || grab(new RegExp('\\bsent\\b.*?\\bto\\s+([^.,;:]+?)' + stop, 'i')) || grab(new RegExp('\\b(?:received|credited)\\b.*?\\bfrom\\s+([^.,;:]+?)' + stop, 'i'))
    || grab(new RegExp('\\bat\\s+([A-Za-z][A-Za-z0-9 &\'.\\-]{1,30}?)' + stop, 'i'));
  if (/cash\s*out/.test(low) && !who) who = (o.provider || 'Wallet') + ' cash out';
  if (/cash\s*in/.test(low) && !who) who = (o.provider || 'Wallet') + ' cash in';
  o.title = who.replace(/\s+/g, ' ').slice(0, 80) || (o.kind === 'income' ? 'Money received' : o.provider ? o.provider + ' payment' : 'Card/bank payment');
  const act = (accts || []).filter(x => !x.archived);
  const tail = /(?:ending|\*{2,}|x{3,}|a\/c\s*\*+|card\s*no\.?)\s*(\d{4})/i.exec(t);
  const byNo = tail && act.filter(x => x.acct_no && x.acct_no.endsWith(tail[1]));
  const byProv = o.provider && act.filter(x => (x.provider || '').toLowerCase().includes(o.provider.toLowerCase()));
  o.accountId = byNo && byNo.length === 1 ? byNo[0].id : byProv && byProv.length === 1 ? byProv[0].id : null;
  return o;
}
$('sms-btn').onclick = () => { $('sms-msg').textContent = ''; $('sms-text').value = ''; $('sms-dialog').showModal(); $('sms-text').focus(); };
$('sms-close').onclick = () => $('sms-dialog').close();
$('sms-go').addEventListener('click', async () => {
  const o = parseSms($('sms-text').value, today(), accounts);
  if (!o.amount) { $('sms-msg').textContent = 'Could not find an amount (Tk / BDT). Check the text and try again.'; return; }
  const note = [o.trx ? 'TrxID: ' + o.trx : '', o.fee ? 'fee ' + fmt(o.fee) : ''].filter(Boolean).join(' · ');
  let dupe = '';
  if (o.trx) { try { const r = await api('/api/search?q=' + encodeURIComponent(o.trx)); const h = [...r.expenses, ...r.income][0]; if (h) dupe = ` Careful: this transaction ID is already recorded (${h.title || h.source}, ${h.spent_on || h.received_on}).`; } catch {} }
  $('sms-dialog').close();
  if (o.kind === 'income') {
    document.querySelector('#tabs button[data-view="income"]').click();
    $('inc-date').value = o.date; $('inc-source').value = o.title; $('inc-amount').value = o.amount; $('inc-note').value = note; if (o.accountId) $('inc-account').value = o.accountId;
    showToast(`Income form filled: ${fmt(o.amount)} from ${o.title}. Check it and press Add income.${dupe}`, null);
  } else {
    document.querySelector('#tabs button[data-view="expenses"]').click();
    resetForm();
    $('spent_on').value = o.date; $('title').value = o.title; $('amount').value = o.amount; $('note').value = note;
    if (o.accountId) $('account').value = o.accountId;
    autofillFromTitle(); updateHint();
    $('form').scrollIntoView({behavior: 'smooth', block: 'center'});
    showToast(`Filled: ${fmt(o.amount)} to ${o.title}${$('category').value ? '' : ' (pick a category)'}.${o.fee ? ' The SMS shows a fee of ' + fmt(o.fee) + ' that is not recorded.' : ''}${dupe}`, null);
  }
});

/* ---------- search everything ---------- */
let searchT;
const goTab = v => document.querySelector(`#tabs button[data-view="${v}"]`).click();
$('gsearch').addEventListener('input', () => {
  clearTimeout(searchT);
  const q = $('gsearch').value.trim();
  if (q.length < 2) { $('search-panel').hidden = true; return; }
  searchT = setTimeout(async () => {
    try {
      const r = await api('/api/search?q=' + encodeURIComponent(q));
      const sec = (title, items) => items.length ? `<h3>${title}</h3>` + items.join('') : '';
      const html =
        sec('Expenses', r.expenses.map(e => `<button class="hit" data-go="expense" data-month="${e.spent_on.slice(0, 7)}" data-text="${esc(e.title)}">${esc(e.spent_on)} · ${esc(e.title)} · ${fmt(e.amount)}${e.account_id ? ' · ' + esc(acctName(e.account_id)) : ''}</button>`)) +
        sec('Income', r.income.map(i => `<button class="hit" data-go="income" data-month="${i.received_on.slice(0, 7)}">${esc(i.received_on)} · ${esc(i.source)} · ${fmt(i.amount)}</button>`)) +
        sec('Transfers', r.transfers.map(t => `<button class="hit" data-go="accounts">${esc(t.moved_on)} · ${esc(t.from_name)} → ${esc(t.to_name)} · ${fmt(t.amount)}</button>`)) +
        sec('Accounts', r.accounts.map(x => `<button class="hit" data-go="accounts">${esc(x.name)} · ${esc(x.provider || TYPE_NAME[x.type])}${x.acct_no ? ' ••' + esc(x.acct_no) : ''}</button>`)) +
        sec('Goals', r.goals.map(x => `<button class="hit" data-go="goals">${esc(x.name)}</button>`));
      $('search-panel').innerHTML = html || '<p class="count">Nothing found.</p>';
      $('search-panel').hidden = false;
    } catch (e) { $('search-panel').innerHTML = `<p class="count">${esc(e.message)}</p>`; $('search-panel').hidden = false; }
  }, 300);
});
$('search-panel').addEventListener('click', ev => {
  const go = ev.target.dataset.go; if (!go) return;
  $('search-panel').hidden = true; $('gsearch').value = '';
  if (go === 'expense') { goTab('expenses'); $('month').value = ev.target.dataset.month; $('f-cat').value = ''; $('f-tag').value = ''; $('all-months').checked = false; $('q').value = ev.target.dataset.text; load(); }
  else if (go === 'income') { goTab('income'); $('inc-month').value = ev.target.dataset.month; loadIncome(); }
  else goTab(go);
});
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') $('search-panel').hidden = true; });
document.addEventListener('click', ev => { if (!ev.target.closest('#search-panel, #gsearch')) $('search-panel').hidden = true; });

/* ---------- more charts ---------- */
const PAL = i => `hsl(${(i * 53 + 150) % 360} 42% ${i % 2 ? 42 : 52}%)`;
async function loadCharts(year) {
  try {
    const d = await api('/api/charts?year=' + year);
    const cats = d.cats.map(c => ({n: c.category, v: Number(c.t)})), tot = cats.reduce((s, c) => s + c.v, 0);
    const top = cats.slice(0, 6), rest = cats.slice(6).reduce((s, c) => s + c.v, 0); if (rest > 0) top.push({n: 'Other categories', v: rest});
    const R = 70, C = 2 * Math.PI * R; let off = 0;
    const arcs = top.map((x, i) => { const len = C * x.v / tot, s = `<circle cx="90" cy="90" r="${R}" fill="none" stroke="${PAL(i)}" stroke-width="28" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 90 90)"><title>${esc(x.n)}: ${fmt(x.v)}</title></circle>`; off += len; return s; }).join('');
    $('ch-donut').innerHTML = tot ? `<div class="donut"><svg viewBox="0 0 180 180" role="img" aria-label="Spending by category">${arcs}<text x="90" y="88" text-anchor="middle" style="fill:var(--ink);font-size:15px;font-weight:700">${fmt0(tot)}</text><text x="90" y="106" text-anchor="middle" style="fill:var(--muted);font-size:11px">spent in ${year}</text></svg>
      <ul>${top.map((x, i) => `<li><span class="dot" style="background:${PAL(i)}"></span>${esc(x.n)} <span class="count">${fmt0(x.v)} · ${Math.round(x.v / tot * 100)}%</span></li>`).join('')}</ul></div>` : '<p class="empty">No expenses this year.</p>';
    const order = [7, 1, 2, 3, 4, 5, 6], names = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'], by = Object.fromEntries(d.wk.map(w => [w.d, Number(w.t)]));
    const vals = order.map(k => by[k] || 0), mx = Math.max(1, ...vals);
    $('ch-week').innerHTML = tot ? `<svg viewBox="0 0 700 190" style="width:100%;height:auto" role="img" aria-label="Spending by weekday">${vals.map((v, i) => { const h = v / mx * 120, x = 40 + i * 90; return `<rect x="${x}" y="${150 - h}" width="60" height="${h}" rx="4" style="fill:var(--bar)"><title>${names[i]}: ${fmt(v)}</title></rect><text x="${x + 30}" y="${144 - h}" text-anchor="middle" style="fill:var(--ink);font-size:12px">${v ? fmt0(v) : ''}</text><text x="${x + 30}" y="172" text-anchor="middle" style="fill:var(--muted);font-size:12px">${names[i]}</text>`; }).join('')}</svg>` : '';
    const cur = Array(12).fill(0), prev = Array(12).fill(0);
    d.mo.forEach(r => (r.y === year ? cur : prev)[r.m - 1] += Number(r.t));
    const m2 = Math.max(1, ...cur, ...prev), gw = 54;
    $('ch-yoy').innerHTML = `<svg viewBox="0 0 700 215" style="width:100%;height:auto" role="img" aria-label="This year compared with last year">${cur.map((v, i) => { const x = 20 + i * gw, h1 = v / m2 * 130, h2 = prev[i] / m2 * 130; return `<rect x="${x}" y="${160 - h2}" width="21" height="${h2}" rx="3" style="fill:var(--line)"><title>${MONTHS[i]} ${year - 1}: ${fmt(prev[i])}</title></rect><rect x="${x + 23}" y="${160 - h1}" width="21" height="${h1}" rx="3" style="fill:var(--bar)"><title>${MONTHS[i]} ${year}: ${fmt(v)}</title></rect><text x="${x + 22}" y="178" text-anchor="middle" style="fill:var(--muted);font-size:11px">${MONTHS[i]}</text>`; }).join('')}
      <g style="font-size:12px;fill:var(--ink)"><rect x="20" y="194" width="14" height="10" style="fill:var(--bar)"/><text x="38" y="204">${year}</text><rect x="90" y="194" width="14" height="10" style="fill:var(--line)"/><text x="108" y="204">${year - 1}</text></g></svg>`;
  } catch (e) { $('ch-donut').textContent = e.message; }
}

/* ---------- recurring ---------- */
async function loadRecurring() {
  try { recurring = await api('/api/recurring'); renderRecurring(); }
  catch (e) { $('rec-msg').textContent = e.message; }
}

function renderRecurring() {
  $('rec-rows').innerHTML = recurring.map(r => `
    <tr${r.active ? '' : ' style="opacity:.55"'}>
      <td>${esc(r.title)}${r.note ? `<span class="note">${esc(r.note)}</span>` : ''}${r.active ? '' : '<span class="note">Paused</span>'}</td>
      <td>${r.kind === 'income' ? 'Income' : esc(r.category)}</td>
      <td>${r.day_of_month}</td>
      <td class="num">${fmt(r.amount)}</td>
      <td class="act">
        <button data-toggle="${r.id}" data-active="${r.active ? 1 : 0}">${r.active ? 'Pause' : 'Resume'}</button>
        <button class="del" data-delrec="${r.id}">Delete</button>
      </td>
    </tr>`).join('');
  $('rec-empty').hidden = recurring.length > 0;
}

$('rec-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    await api('/api/recurring', {method: 'POST', body: JSON.stringify({
      kind: $('rec-kind').value, account_id: $('rec-account').value || null, title: $('rec-title').value, category: $('rec-category').value, amount: $('rec-amount').value,
      day_of_month: $('rec-day').value, start_month: $('rec-start').value, note: $('rec-note').value,
    })});
    $('rec-form').reset(); recKind(); $('rec-day').value = 1; $('rec-start').value = today().slice(0, 7);
    $('rec-msg').textContent = '';
    loadRecurring();
  } catch (e) { $('rec-msg').textContent = e.message; }
});

function recKind() {
  const inc = $('rec-kind').value === 'income';
  $('rec-category').closest('label').hidden = inc; $('rec-category').required = !inc;
}
$('rec-kind').addEventListener('change', recKind);

$('rec-rows').addEventListener('click', async ev => {
  const t = ev.target.dataset.toggle, d = ev.target.dataset.delrec;
  try {
    if (t) {
      await api(`/api/recurring/${t}/active`, {method: 'PUT', body: JSON.stringify({active: ev.target.dataset.active !== '1'})});
      loadRecurring();
    }
    if (d && confirm('Delete this recurring expense? Expenses already created are kept.')) {
      await api('/api/recurring/' + d, {method: 'DELETE'});
      loadRecurring();
    }
  } catch (e) { $('rec-msg').textContent = e.message; }
});

/* ---------- backup / restore ---------- */
$('restore-btn').addEventListener('click', async () => {
  const msg = $('restore-msg'), file = $('restore-file').files[0];
  msg.style.color = '';
  if (!file) { msg.textContent = 'Choose a backup file first.'; return; }
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { msg.textContent = 'That file is not valid JSON.'; return; }
  const n = data.enc ? 'encrypted' : (Array.isArray(data.expenses) ? data.expenses.length : 0) + ' expenses';
  if (data.enc && !$('restore-pass').value) { msg.textContent = 'Enter the passphrase for this encrypted backup.'; return; }
  if (!confirm(`Replace ALL current data with this backup (${n})? This cannot be undone.`)) return;
  try {
    const r = await api('/api/restore', {method: 'POST', body: JSON.stringify(data.enc ? {ledger_encrypted: true, file: data, passphrase: $('restore-pass').value} : data)});
    $('restore-pass').value = '';
    msg.style.color = 'var(--accent)';
    msg.textContent = `Restored ${r.expenses} expenses, ${r.categories} categories, ${r.recurring} recurring.`;
    $('restore-file').value = '';
    await loadCategories(); await load();
  } catch (e) { msg.textContent = e.message; }
});

/* ---------- password lock ---------- */
function showLock() {
  $('lock').hidden = false; $('lock-pw').value = ''; $('lock-msg').textContent = '';
  $('lock-pw').focus();
}

$('lock-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    await api('/api/auth/login', {method: 'POST', body: JSON.stringify({password: $('lock-pw').value})});
    $('lock').hidden = true; $('lock-btn').hidden = false;
    await boot();
  } catch (e) { $('lock-msg').textContent = e.message; }
});

$('lock-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  location.reload();
});

async function loadSecurity() {
  const s = await api('/api/auth/status');
  $('sec-title').textContent = s.enabled ? 'Password lock is on' : 'Password lock is off';
  $('sec-info').textContent = s.enabled
    ? 'The app asks for the password in each new browser session (you are signed out after 30 minutes of inactivity). Note: backup files and the MySQL database itself are not encrypted.'
    : 'Set a password so nobody else using this PC can open your expenses in the app. Backup files and the MySQL database itself are not encrypted.';
  $('sec-cur-wrap').hidden = !s.enabled;
  $('sec-remove').hidden = !s.enabled;
  $('sec-save').textContent = s.enabled ? 'Change password' : 'Set password';
  $('lock-btn').hidden = !s.enabled;
  $('sec-msg').textContent = '';
  try { const log = s.enabled ? await api('/api/security/log') : []; $('sec-log').innerHTML = log.map(l => `<li>${esc(l)}</li>`).join('') || '<li>Nothing recorded yet.</li>'; } catch {}
}

$('sec-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const msg = $('sec-msg'); msg.style.color = '';
  if ($('sec-new').value !== $('sec-new2').value) { msg.textContent = 'The new passwords do not match.'; return; }
  try {
    await api('/api/auth/set', {method: 'POST', body: JSON.stringify({current: $('sec-cur').value, password: $('sec-new').value})});
    $('sec-form').reset();
    await loadSecurity();
    msg.style.color = 'var(--accent)'; msg.textContent = 'Password saved.';
  } catch (e) { msg.textContent = e.message; }
});

$('sec-remove').addEventListener('click', async () => {
  const msg = $('sec-msg'); msg.style.color = '';
  if (!$('sec-cur').value) { msg.textContent = 'Enter your current password to remove it.'; return; }
  if (!confirm('Remove the password lock?')) return;
  try {
    await api('/api/auth/remove', {method: 'POST', body: JSON.stringify({current: $('sec-cur').value})});
    $('sec-form').reset();
    await loadSecurity();
    msg.style.color = 'var(--accent)'; msg.textContent = 'Password removed.';
  } catch (e) { msg.textContent = e.message; }
});

/* ---------- start ---------- */
async function boot() {
  await loadCategories(); loadTags(); loadTitles(); loadSources(); loadAccounts().then(loadReminders); armIdle();
  await api('/api/recurring/run', {method: 'POST', body: '{}'});
  await load();
  autoSummary();
  extrasInit();
  extras2Init();
}

$('month').value = curMonth();
$('year').value = new Date().getFullYear();
resetForm();
$('rec-start').value = today().slice(0, 7);
$('inc-month').value = curMonth();
$('trend-month').value = curMonth();
$('inc-date').value = today();
$('tr-date').value = today();
$('st-month').value = today().slice(0, 7);
accTypeToggle();
(async () => {
  try {
    const s = await api('/api/auth/status');
    $('lock-btn').hidden = !s.enabled;
    if (s.enabled && !s.authed) { showLock(); return; }
    await boot();
  } catch (e) { $('msg').textContent = 'Could not load: ' + e.message; }
})();
