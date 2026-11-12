/* Extra features. Loaded before app.js; everything starts from extrasInit(), which boot() calls. */
let extrasReady = false, rules = [], wishlist = [];
const pad2 = n => String(n).padStart(2, '0');

/* ---------- budget month (salary day) ---------- */
async function loadPeriod() {
  try {
    const s = await api('/api/settings/period'), changed = s.start_day !== periodStartDay;
    periodStartDay = s.start_day; $('period-day').value = s.start_day; updatePeriodLabel();
    if (changed) { $('month').value = curMonth(); $('inc-month').value = curMonth(); $('trend-month').value = curMonth(); load(); loadIncome(); }
  } catch {}
}
function updatePeriodLabel() {
  const m = $('month').value; if (!m || periodStartDay === 1) { $('period-label').textContent = ''; return; }
  const [y, mo] = m.split('-').map(Number), a = new Date(y, mo - 1, periodStartDay), b = new Date(y, mo, periodStartDay - 1);
  const f = d => `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  $('period-label').textContent = `${f(a)} – ${f(b)}`;
}

/* ---------- 1. type a sentence ---------- */
function parseQuick(text, todayStr, accts) {
  const words = String(text).trim().replace(/\s+/g, ' ').split(' ').filter(Boolean), low = words.map(w => w.toLowerCase().replace(/[,;]+$/, ''));
  const used = new Set(), o = {title: '', amount: null, date: todayStr, accountId: null, category: ''};
  const base = new Date(todayStr + 'T00:00:00'), iso = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const back = n => { const d = new Date(base); d.setDate(d.getDate() - n); return iso(d); };
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  low.forEach((w, i) => {
    let m;
    if (w === 'today' || w === 'aj' || w === 'aaj') used.add(i);
    else if (w === 'yesterday' || w === 'gotokal') { o.date = back(1); used.add(i); }
    else if (w === 'ago' && i >= 2 && /^\d+$/.test(low[i - 2]) && /^days?$/.test(low[i - 1])) { o.date = back(Number(low[i - 2])); [i, i - 1, i - 2].forEach(k => used.add(k)); }
    else if (DAYS.includes(w.slice(0, 3)) && /^(mon|tue|wed|thu|fri|sat|sun)(day|sday|nesday|rsday|urday)?$/.test(w)) { o.date = back((base.getDay() - DAYS.indexOf(w.slice(0, 3)) + 7) % 7); used.add(i); }
    else if ((m = /^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/.exec(w))) {
      const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : base.getFullYear();
      if (+m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12) { o.date = `${y}-${pad2(m[2])}-${pad2(m[1])}`; used.add(i); }
    }
  });
  const nums = low.map((w, i) => ({w, i, m: /^(?:tk\.?|৳)?([\d,]+(?:\.\d+)?)(?:tk|taka|৳)?$/i.exec(w)})).filter(x => x.m && !used.has(x.i));
  const cur = x => /(tk|৳)/i.test(x.w) || /^(tk|taka|৳)$/i.test(low[x.i + 1] || '') || /^(tk\.?|৳)$/i.test(low[x.i - 1] || '');
  const pick = nums.find(cur) || nums[nums.length - 1];
  if (pick) { o.amount = Number(pick.m[1].replace(/,/g, '')); used.add(pick.i); if (/^(tk|taka|৳)$/i.test(low[pick.i + 1] || '')) used.add(pick.i + 1); if (/^(tk\.?|৳)$/i.test(low[pick.i - 1] || '')) used.add(pick.i - 1); }
  const act = (accts || []).filter(a => !a.archived), cats = (typeof categories !== 'undefined' ? categories : []);
  low.forEach((w, i) => {
    if (used.has(i) || !w) return;
    if (!o.accountId) {
      const a = act.find(a => (w === 'cash' && a.type === 'cash') || (a.acct_no && a.acct_no === w) || (a.provider || '').toLowerCase().split(/[\s(]+/)[0] === w ||
        (w.length >= 4 && (a.provider || '').toLowerCase().includes(w)) || (w.length >= 3 && a.name.toLowerCase().split(/\s+/).includes(w)));
      if (a) { o.accountId = a.id; used.add(i); return; }
    }
    const c = cats.find(c => c.name.toLowerCase() === w); if (c && !o.category) { o.category = c.name; used.add(i); }
  });
  const t = words.filter((w, i) => !used.has(i)).join(' ').replace(/^(for|on|at|to)\s+/i, '').trim();
  o.title = t ? t[0].toUpperCase() + t.slice(1) : '';
  return o;
}
function quickFill() {
  const text = $('quick-input').value.trim(); if (!text) return;
  const o = parseQuick(text, today(), accounts);
  goTab('expenses'); resetForm();
  $('spent_on').value = o.date; if (o.title) $('title').value = o.title; if (o.amount) $('amount').value = o.amount;
  if (o.accountId) $('account').value = o.accountId; if (o.category) $('category').value = o.category;
  autofillFromTitle(); applyRuleToForm(); updateHint();
  $('quick-input').value = '';
  const miss = [!$('title').value && 'a title', !$('amount').value && 'an amount', !$('category').value && 'a category'].filter(Boolean);
  showToast(`Filled the form from "${text}".${miss.length ? ' Still needed: ' + miss.join(', ') + '.' : ' Check it and press Add.'}`, null);
  ($('title').value ? ($('amount').value ? $('save') : $('amount')) : $('title')).focus();
}

/* ---------- 2. auto-categorize rules ---------- */
async function loadRules() {
  try {
    rules = await api('/api/rules');
    $('rule-rows').innerHTML = rules.map(r => `<tr><td>${esc(r.pattern)}</td><td>${esc(r.category)}</td><td>${esc(r.tags || '')}</td><td class="act"><button class="del" data-delrule="${r.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="count">No rules yet.</td></tr>';
  } catch {}
}
function applyRuleToForm() {
  if ($('id').value) return;
  const t = $('title').value.toLowerCase(); if (t.length < 2) return;
  const r = rules.filter(x => t.includes(x.pattern.toLowerCase())).sort((a, b) => b.pattern.length - a.pattern.length)[0];
  if (!r) return;
  if (!$('category').value) $('category').value = r.category;
  if (!$('tags').value && r.tags) $('tags').value = r.tags;
  updateHint();
}

/* ---------- 5/6. rollover + suggested budgets ---------- */
async function applyRollover() {
  try {
    const eff = await api('/api/budgets/effective?month=' + $('month').value);
    for (const c of categories) {
      if (c.base === undefined) c.base = c.monthly_budget;
      const e = eff[c.name]; c.carry = e ? e.carry : 0;
      c.monthly_budget = e ? e.effective : c.base;
    }
  } catch {}
}
async function loadSuggestions() {
  const msg = $('sug-msg'); msg.textContent = '';
  try {
    const s = await api('/api/budgets/suggest');
    $('sug-rows').innerHTML = s.length ? s.map(x => `<tr><td>${esc(x.category)}</td><td class="num">${fmt(x.average)}</td><td class="num">${x.current == null ? '–' : fmt(x.current)}</td><td class="num"><strong>${fmt(x.suggested)}</strong></td><td class="act"><button data-sug="${esc(x.category)}" data-val="${x.suggested}">Use</button></td></tr>`).join('') : '<tr><td colspan="5" class="count">Not enough spending history yet (needs at least one finished month).</td></tr>';
    $('sug-all').hidden = !s.length;
  } catch (e) { msg.textContent = e.message; }
}

/* ---------- 7. goals: set aside each month ---------- */
function calcMonthly() {
  const t = Number($('goal-target').value), d = $('goal-date').value;
  if (!t || !d) { $('goal-msg').textContent = 'Enter the target amount and a target date first.'; return; }
  const now = new Date(), end = new Date(d), mo = Math.max(1, (end.getFullYear() - now.getFullYear()) * 12 + end.getMonth() - now.getMonth() + 1);
  $('goal-monthly').value = Math.ceil(t / mo * 100) / 100; $('goal-msg').textContent = `${mo} month${mo > 1 ? 's' : ''} to go: about ${fmt(t / mo)} a month.`;
}

/* ---------- 8. wishlist ---------- */
async function loadWishlist() {
  try {
    wishlist = await api('/api/wishlist');
    let remaining = null, surplus = null;
    const cash = accounts.filter(a => !a.archived).reduce((s, a) => s + (a.type === 'card' ? 0 : Number(a.balance)), 0) - accounts.filter(a => !a.archived && a.type === 'card').reduce((s, a) => s - Number(a.balance), 0);
    try {
      const eff = await api('/api/budgets/effective?month=' + curMonth()), cm = curMonth();
      const ex = await api('/api/expenses?month=' + cm), inc = await api('/api/income?month=' + cm);
      const spent = {}; ex.forEach(e => spent[e.category] = (spent[e.category] || 0) + Number(e.amount));
      const names = Object.keys(eff);
      if (names.length) remaining = names.reduce((s, n) => s + eff[n].effective - (spent[n] || 0), 0);
      else if (inc.length) remaining = inc.reduce((s, i) => s + Number(i.amount), 0) - ex.reduce((s, e) => s + Number(e.amount), 0);
      const t = await api('/api/trends?end=' + cm), last = t.months.slice(8, 11).filter(m => m.income > 0 || m.spent > 0);
      if (last.length) surplus = last.reduce((s, m) => s + m.income - m.spent, 0) / last.length;
    } catch {}
    $('wish-list').innerHTML = wishlist.map(w => {
      const p = Number(w.price); let verdict;
      if (w.bought) verdict = 'Bought.';
      else if (remaining != null && p <= remaining) verdict = `Affordable now: it fits in what is left this month (${fmt(remaining)}).`;
      else if (surplus != null && surplus > 0) { const gap = p - Math.max(0, remaining || 0), n = Math.ceil(gap / surplus); verdict = `About ${n} month${n > 1 ? 's' : ''} away at your recent saving rate of ${fmt(surplus)} a month.`; }
      else verdict = remaining == null && surplus == null ? 'Add income or budgets to see if you can afford this.' : 'Not yet: recent months show no monthly surplus.';
      const enough = !w.bought && accounts.length ? `<br><small class="count">${cash >= p ? 'Your accounts hold enough to pay for it.' : 'Your accounts hold ' + fmt(cash) + ' net, less than the price.'}</small>` : '';
      return `<div class="goal"><div class="goal-top"><strong${w.bought ? ' style="text-decoration:line-through"' : ''}>${esc(w.name)}</strong><span>${fmt(p)}</span></div><p class="count">${esc(verdict)}${enough}${w.note ? '<br>' + esc(w.note) : ''}</p>
        <div class="goal-act"><button data-wbuy="${w.id}" data-state="${w.bought ? 0 : 1}">${w.bought ? 'Not bought' : 'Mark bought'}</button><button class="del" data-wdel="${w.id}">Delete</button></div></div>`;
    }).join('') || '<p class="empty">Nothing on your wishlist yet.</p>';
  } catch (e) { $('wish-msg').textContent = e.message; }
}

/* ---------- 9/10/11. tracker: repayable expenses, invoices, warranties ---------- */
async function loadTracker() {
  let recent = []; try { recent = await api('/api/expenses/recent'); } catch {}
  const opts = '<option value="">Choose an expense</option>' + recent.map(e => `<option value="${e.id}">${esc(e.spent_on)} · ${esc(e.title)} · ${fmt(e.amount)}</option>`).join('');
  const cur = ['rp-expense', 'wr-expense'].map(id => $(id).value); $('rp-expense').innerHTML = opts; $('wr-expense').innerHTML = opts.replace('Choose an expense', 'No linked expense');
  $('rp-expense').value = cur[0]; $('wr-expense').value = cur[1];
  const acctOpts = '<option value="">No account</option>' + accounts.filter(a => !a.archived).map(a => `<option value="${a.id}">${esc(acctLabel(a))}</option>`).join('');
  $('inv-account').innerHTML = acctOpts;
  try {
    const rp = await api('/api/repayables'), pend = rp.filter(r => !r.repaid_on);
    $('rp-sum').textContent = pend.length ? `Waiting to be repaid: ${fmt(pend.reduce((s, r) => s + Number(r.amount || 0), 0))} from ${new Set(pend.map(r => r.who)).size} person(s)/place(s)` : '';
    $('rp-rows').innerHTML = rp.map(r => `<tr><td>${esc(r.title || '(deleted expense)')}<span class="note">${esc(r.spent_on || '')}</span></td><td>${esc(r.who)}</td><td class="num">${fmt(r.amount || 0)}</td>
      <td class="act">${r.repaid_on ? `Repaid ${esc(r.repaid_on)} <button data-rpun="${r.id}">Undo</button>` : `<select data-rpacct="${r.id}" aria-label="Received into">${acctOpts}</select><button data-rppaid="${r.id}">Mark repaid</button>`}<button class="del" data-rpdel="${r.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="count">Nothing here yet.</td></tr>';
  } catch {}
  try {
    const inv = await api('/api/invoices'), un = inv.filter(i => i.status !== 'paid'), od = inv.filter(i => i.status === 'overdue');
    $('inv-sum').textContent = inv.length ? `Outstanding: ${fmt(un.reduce((s, i) => s + Number(i.amount), 0))}${od.length ? ` · Overdue: ${fmt(od.reduce((s, i) => s + Number(i.amount), 0))} (${od.length})` : ''}` : '';
    $('inv-rows').innerHTML = inv.map(i => `<tr><td>${esc(i.client)}${i.number ? `<span class="note">#${esc(i.number)}</span>` : ''}</td><td>${esc(i.issued_on)}<span class="note">due ${esc(i.due_on || '–')}</span></td><td class="num">${fmt(i.amount)}</td>
      <td><span class="badge ${i.status.replace(' ', '-')}">${i.status}</span></td><td class="act">${i.status === 'paid' ? `<button data-invun="${i.id}">Mark unpaid</button>` : `<button data-invpaid="${i.id}" data-acct="${i.account_id || ''}">Mark paid</button>`}<button class="del" data-invdel="${i.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="count">No invoices yet.</td></tr>';
  } catch {}
  try {
    const w = await api('/api/warranties');
    $('wr-rows').innerHTML = w.map(x => `<tr><td>${esc(x.item)}${x.expense_title ? `<span class="note">${esc(x.expense_title)}</span>` : ''}</td><td>${esc(x.expires_on)}</td>
      <td><span class="badge ${x.days_left < 0 ? 'overdue' : x.days_left <= 30 ? 'due-soon' : 'pending'}">${x.days_left < 0 ? 'expired' : x.days_left + ' days left'}</span></td>
      <td class="act">${x.expense_id ? `<button data-wrrec="${x.expense_id}">Receipts</button>` : ''}<button class="del" data-wrdel="${x.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="count">No warranties yet.</td></tr>';
  } catch {}
}
async function extraReminders() {
  try {
    const r = await api('/api/reminders/extra'), d = n => n === 0 ? 'today' : n < 0 ? `${-n} day${n < -1 ? 's' : ''} ago` : `in ${n} day${n > 1 ? 's' : ''}`;
    $('reminders').innerHTML += r.invoices.map(i => `<div class="alert ${i.days < 0 ? 'over' : 'warn'}">Invoice ${i.number ? '#' + esc(i.number) + ' ' : ''}for ${esc(i.client)} (${fmt(i.amount)}) ${i.days < 0 ? 'was due' : 'is due'} ${d(i.days)}.</div>`).join('')
      + r.warranties.map(w => `<div class="alert warn">Warranty for ${esc(w.item)} ends ${d(w.days)} (${esc(w.date)}).</div>`).join('');
  } catch {}
}

/* ---------- 12. credit-card cost calculator ---------- */
function simulate(bal, apr, payFn) {
  let months = 0, interest = 0;
  while (bal > 0.5 && months < 600) {
    const i = bal * apr / 1200; bal += i; interest += i;
    const p = Math.min(payFn(bal), bal); if (p <= i * 0.999 && months > 0 && p < bal) return null;
    bal -= p; months++;
  }
  return bal > 0.5 ? null : {months, interest};
}
function ccCalc() {
  const bal = Number($('cc-bal').value), apr = Number($('cc-apr').value), minPct = Number($('cc-min').value) || 5, pay = Number($('cc-pay').value);
  if (!(bal > 0) || !(apr >= 0)) { $('cc-out').textContent = 'Enter the balance and the yearly interest rate.'; return; }
  const line = (label, r) => `<li><strong>${label}</strong>: ${r ? `${r.months} month${r.months > 1 ? 's' : ''} to clear, ${fmt(r.interest)} in interest` : 'never clears at this payment (it does not cover the interest)'}</li>`;
  const minOnly = simulate(bal, apr, b => Math.max(b * minPct / 100, 1)), fixed = pay > 0 ? simulate(bal, apr, () => pay) : null;
  const oneMonth = bal * apr / 1200;
  $('cc-out').innerHTML = `<ul><li><strong>Pay in full by the due date</strong>: ${fmt(0)} interest</li><li><strong>Miss the due date once</strong>: roughly ${fmt(oneMonth)} interest in the next month</li>${line(`Only the minimum (${minPct}% of balance)`, minOnly)}${pay > 0 ? line(`Fixed ${fmt(pay)} a month`, fixed) : ''}
    ${pay > 0 && minOnly && fixed ? `<li>Paying ${fmt(pay)} a month instead of the minimum saves about <strong>${fmt(minOnly.interest - fixed.interest)}</strong> in interest.</li>` : ''}</ul><p class="count">An estimate: interest is charged monthly at the yearly rate divided by 12; fees and your bank's exact rules are not included.</p>`;
}
function ccFill() {
  const a = accounts.find(x => String(x.id) === $('cc-card').value);
  if (a) $('cc-bal').value = Math.max(0, -Number(a.balance)).toFixed(2);
}

/* ---------- 13. calendar ---------- */
async function loadCalendar() {
  const ym = $('cal-month').value; if (!ym) return;
  try {
    const [ex, rec] = await Promise.all([api('/api/expenses?month=' + ym), api('/api/recurring')]);
    const [y, m] = ym.split('-').map(Number), start = new Date(y, m - 1, periodStartDay), end = new Date(y, m, periodStartDay);
    const by = {}; ex.forEach(e => { (by[e.spent_on] = by[e.spent_on] || []).push(e); });
    const sums = Object.values(by).map(l => l.reduce((s, e) => s + Number(e.amount), 0)), mx = Math.max(1, ...sums);
    const days = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']; let cells = days.map(d => `<div class="cal-h">${d}</div>`).join('');
    cells += '<div></div>'.repeat((start.getDay() + 1) % 7);
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, list = by[key] || [], tot = list.reduce((s, e) => s + Number(e.amount), 0);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const bills = rec.filter(r => r.active && Math.min(r.day_of_month, last) === d.getDate()).map(r => r.title);
      cells += `<div class="cal-d" style="${tot ? `background:color-mix(in srgb, var(--bar) ${Math.round(15 + tot / mx * 70)}%, var(--card))` : ''}" title="${esc(list.map(e => e.title + ' ' + fmt(e.amount)).join('\n') + (bills.length ? '\nDue: ' + bills.join(', ') : ''))}"><span>${d.getDate()}</span><b>${tot ? fmt0(tot) : ''}</b>${bills.length ? '<i title="bill due">•</i>' : ''}</div>`;
    }
    $('cal-grid').innerHTML = cells;
  } catch (e) { $('cal-grid').textContent = e.message; }
}

/* ---------- 3. duplicates + 15. test my backup ---------- */
async function findDuplicates() {
  $('dup-msg').textContent = '';
  try {
    const g = await api('/api/duplicates');
    $('dup-list').innerHTML = g.map((x, gi) => `<div class="goal"><p class="count">${esc(x.reason)}</p>${x.items.map((i, k) => `<label class="dup"><input type="radio" name="keep${gi}" value="${i.id}" ${k === 0 ? 'checked' : ''}> ${esc(i.spent_on)} · ${esc(i.title)} · ${fmt(i.amount)}${i.account_id ? ' · ' + esc(acctName(i.account_id)) : ''}</label>`).join('')}
      <div class="goal-act"><button data-dupmerge="${gi}">Keep the selected one, delete the rest</button></div></div>`).join('') || '<p class="count">No duplicates found.</p>';
    $('dup-list').dataset.groups = JSON.stringify(g.map(x => x.items.map(i => i.id)));
  } catch (e) { $('dup-msg').textContent = e.message; }
}
async function testBackup() {
  const msg = $('restore-msg'), file = $('restore-file').files[0]; msg.style.color = '';
  if (!file) { msg.textContent = 'Choose a backup file first.'; return; }
  let data; try { data = JSON.parse(await file.text()); } catch { msg.textContent = 'That file is not valid JSON.'; return; }
  if (data.enc && !$('restore-pass').value) { msg.textContent = 'Enter the passphrase for this encrypted backup.'; return; }
  try {
    const r = await api('/api/restore', {method: 'POST', body: JSON.stringify(data.enc ? {dry: true, ledger_encrypted: true, file: data, passphrase: $('restore-pass').value} : {...data, dry: true})});
    msg.style.color = 'var(--accent)';
    msg.textContent = `This backup is good${r.created ? ' (made ' + r.created.slice(0, 10) + ')' : ''}. It would restore ${r.expenses} expenses, ${r.income} income entries, ${r.accounts} accounts, ${r.transfers} transfers, ${r.goals} goals and ${r.categories} categories. Nothing was changed.`;
  } catch (e) { msg.textContent = 'Problem with this backup: ' + e.message; }
}

/* ---------- 14. copy the month summary as text ---------- */
function summaryText() {
  const out = [];
  $('sum-body').querySelectorAll('h1, h2, p, tr').forEach(el => {
    const t = [...(el.tagName === 'TR' ? el.children : [el])].map(c => c.textContent.trim()).filter(Boolean);
    if (!t.length) return;
    out.push(el.tagName === 'H1' || el.tagName === 'H2' ? `\n*${t[0]}*` : el.tagName === 'TR' ? '• ' + t.join(' | ') : t[0]);
  });
  return out.join('\n').trim();
}
async function copySummary() {
  const text = summaryText();
  try { await navigator.clipboard.writeText(text); showToast('Summary copied. Paste it into WhatsApp or an email.', null); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); showToast('Summary copied.', null); }
}

/* ---------- start ---------- */
async function extrasInit() {
  if (extrasReady) { loadRules(); loadPeriod(); loadReminders(); return; }
  extrasReady = true;
  // wrap existing functions so the new data is applied without touching their code
  const _load = load; load = async function () { await applyRollover(); updatePeriodLabel(); return _load.apply(this, arguments); };
  const _rem = loadReminders; loadReminders = async function () { await _rem.apply(this, arguments); await extraReminders(); };
  const _tab = document.getElementById('tabs');
  _tab.addEventListener('click', ev => {
    const v = ev.target.dataset.view; if (!v) return;
    if (v === 'tracker') loadTracker(); if (v === 'goals') loadWishlist(); if (v === 'categories') { loadRules(); loadPeriod(); }
    if (v === 'report') { if (!$('cal-month').value) $('cal-month').value = curMonth(); loadCalendar(); }
    if (v === 'accounts') { const c = $('cc-card'), cur = c.value; c.innerHTML = '<option value="">Enter the balance myself</option>' + accounts.filter(a => !a.archived && a.type === 'card').map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join(''); c.value = cur; }
  });
  $('month').addEventListener('change', updatePeriodLabel);
  // quick sentence entry
  $('quick-input').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); quickFill(); } });
  $('quick-go').addEventListener('click', quickFill);
  // rules
  $('title').addEventListener('input', applyRuleToForm); $('title').addEventListener('change', applyRuleToForm);
  $('rule-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    try { await api('/api/rules', {method: 'POST', body: JSON.stringify({pattern: $('rule-pattern').value, category: $('rule-category').value, tags: $('rule-tags').value})}); $('rule-form').reset(); $('rule-msg').textContent = ''; loadRules(); loadCategories(); }
    catch (e) { $('rule-msg').textContent = e.message; }
  });
  $('rule-rows').addEventListener('click', async ev => { const id = ev.target.dataset.delrule; if (id) { await api('/api/rules/' + id, {method: 'DELETE'}); loadRules(); } });
  const applyRules = async all => { try { const r = await api('/api/rules/apply', {method: 'POST', body: JSON.stringify({all})}); $('rule-msg').style.color = 'var(--accent)'; $('rule-msg').textContent = `${r.changed} existing entr${r.changed === 1 ? 'y' : 'ies'} updated.`; load(); loadTags(); } catch (e) { $('rule-msg').style.color = ''; $('rule-msg').textContent = e.message; } };
  $('rules-apply').onclick = () => applyRules(false);
  $('rules-apply-all').onclick = () => { if (confirm('Re-categorize every past entry that matches a rule, even ones you categorized yourself?')) applyRules(true); };
  // budget month
  $('period-save').onclick = async () => {
    try { await api('/api/settings/period', {method: 'PUT', body: JSON.stringify({start_day: $('period-day').value})}); $('period-msg').style.color = 'var(--accent)'; $('period-msg').textContent = 'Saved. Months now run from this day.'; await loadPeriod(); load(); loadIncome(); loadAccounts(); }
    catch (e) { $('period-msg').style.color = ''; $('period-msg').textContent = e.message; }
  };
  $('period-day').innerHTML = Array.from({length: 28}, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
  // rollover checkbox + suggestions
  $('cat-rows').addEventListener('change', async ev => {
    const n = ev.target.dataset.roll; if (!n) return;
    try { await api(`/api/categories/${encodeURIComponent(n)}/rollover`, {method: 'PUT', body: JSON.stringify({rollover: ev.target.checked})}); await loadCategories(); load(); } catch (e) { $('cat-msg').textContent = e.message; }
  });
  $('sug-btn').onclick = loadSuggestions;
  const useSug = async (name, val) => api('/api/categories/' + encodeURIComponent(name), {method: 'PUT', body: JSON.stringify({monthly_budget: val})});
  $('sug-rows').addEventListener('click', async ev => { const n = ev.target.dataset.sug; if (!n) return; try { await useSug(n, ev.target.dataset.val); await loadCategories(); renderCategories(); load(); loadSuggestions(); } catch (e) { $('sug-msg').textContent = e.message; } });
  $('sug-all').onclick = async () => { try { for (const b of $('sug-rows').querySelectorAll('[data-sug]')) await useSug(b.dataset.sug, b.dataset.val); await loadCategories(); renderCategories(); load(); loadSuggestions(); $('sug-msg').textContent = 'All suggestions applied.'; } catch (e) { $('sug-msg').textContent = e.message; } };
  // goals monthly set-aside (the goal is created by app.js; this adds the monthly amount)
  $('goal-calc').onclick = calcMonthly;
  $('goal-form').addEventListener('submit', async () => {
    const m = $('goal-monthly').value, name = $('goal-name').value; if (!m) return;
    setTimeout(async () => { try { const g = (await api('/api/goals')).filter(x => x.name === name).pop(); if (g) { await api(`/api/goals/${g.id}/auto`, {method: 'PUT', body: JSON.stringify({monthly_amount: m})}); loadGoals(); } } catch {} $('goal-monthly').value = ''; }, 600);
  }, true);
  // wishlist
  $('wish-form').addEventListener('submit', async ev => { ev.preventDefault(); try { await api('/api/wishlist', {method: 'POST', body: JSON.stringify({name: $('wish-name').value, price: $('wish-price').value, note: $('wish-note').value})}); $('wish-form').reset(); $('wish-msg').textContent = ''; loadWishlist(); } catch (e) { $('wish-msg').textContent = e.message; } });
  $('wish-list').addEventListener('click', async ev => {
    const d = ev.target.dataset;
    if (d.wbuy) { await api('/api/wishlist/' + d.wbuy, {method: 'PUT', body: JSON.stringify({bought: d.state === '1'})}); loadWishlist(); }
    if (d.wdel && confirm('Delete this wishlist item?')) { await api('/api/wishlist/' + d.wdel, {method: 'DELETE'}); loadWishlist(); }
  });
  // tracker
  const post = (url, body) => api(url, {method: 'POST', body: JSON.stringify(body || {})});
  $('rp-form').addEventListener('submit', async ev => { ev.preventDefault(); try { await post('/api/repayables', {expense_id: $('rp-expense').value, who: $('rp-who').value}); $('rp-who').value = ''; $('rp-msg').textContent = ''; loadTracker(); } catch (e) { $('rp-msg').textContent = e.message; } });
  $('rp-rows').addEventListener('click', async ev => {
    const d = ev.target.dataset;
    try {
      if (d.rppaid) { await post(`/api/repayables/${d.rppaid}/repaid`, {account_id: document.querySelector(`[data-rpacct="${d.rppaid}"]`).value || null, date: today()}); loadTracker(); loadAccounts(); }
      if (d.rpun) { await post(`/api/repayables/${d.rpun}/unpaid`); loadTracker(); loadAccounts(); }
      if (d.rpdel && confirm('Remove this from the list? (A repayment already recorded as income stays.)')) { await api('/api/repayables/' + d.rpdel, {method: 'DELETE'}); loadTracker(); }
    } catch (e) { $('rp-msg').textContent = e.message; }
  });
  $('inv-form').addEventListener('submit', async ev => { ev.preventDefault(); try { await post('/api/invoices', {client: $('inv-client').value, number: $('inv-number').value, amount: $('inv-amount').value, issued_on: $('inv-issued').value, due_on: $('inv-due').value, account_id: $('inv-account').value || null, note: $('inv-note').value}); $('inv-form').reset(); $('inv-issued').value = today(); $('inv-msg').textContent = ''; loadTracker(); } catch (e) { $('inv-msg').textContent = e.message; } });
  $('inv-rows').addEventListener('click', async ev => {
    const d = ev.target.dataset;
    try {
      if (d.invpaid) { await post(`/api/invoices/${d.invpaid}/paid`, {date: today(), account_id: d.acct || null}); loadTracker(); loadAccounts(); showToast('Marked paid and added to your income.', null); }
      if (d.invun) { await post(`/api/invoices/${d.invun}/unpaid`); loadTracker(); loadAccounts(); }
      if (d.invdel && confirm('Delete this invoice? (Income already recorded stays.)')) { await api('/api/invoices/' + d.invdel, {method: 'DELETE'}); loadTracker(); }
    } catch (e) { $('inv-msg').textContent = e.message; }
  });
  $('wr-form').addEventListener('submit', async ev => { ev.preventDefault(); try { await post('/api/warranties', {item: $('wr-item').value, bought_on: $('wr-bought').value, expires_on: $('wr-expires').value, expense_id: $('wr-expense').value || null, note: ''}); $('wr-form').reset(); $('wr-msg').textContent = ''; loadTracker(); loadReminders(); } catch (e) { $('wr-msg').textContent = e.message; } });
  $('wr-rows').addEventListener('click', async ev => {
    const d = ev.target.dataset;
    if (d.wrrec) openReceipts(d.wrrec);
    if (d.wrdel && confirm('Delete this warranty?')) { await api('/api/warranties/' + d.wrdel, {method: 'DELETE'}); loadTracker(); loadReminders(); }
  });
  // card calculator, calendar
  $('cc-card').addEventListener('change', ccFill); $('cc-go').onclick = ccCalc;
  $('cal-month').addEventListener('change', loadCalendar);
  // duplicates, backup test, copy summary
  $('dup-btn').onclick = findDuplicates;
  $('dup-list').addEventListener('click', async ev => {
    const gi = ev.target.dataset.dupmerge; if (gi === undefined) return;
    const ids = JSON.parse($('dup-list').dataset.groups)[gi], keep = Number(document.querySelector(`input[name="keep${gi}"]:checked`).value);
    try { const r = await post('/api/duplicates/merge', {keep, remove: ids.filter(i => i !== keep)}); showToast(`Deleted ${r.removed} duplicate${r.removed > 1 ? 's' : ''}.`, null); load(); loadAccounts(); findDuplicates(); } catch (e) { $('dup-msg').textContent = e.message; }
  });
  $('test-btn').onclick = testBackup;
  $('sum-copy').onclick = copySummary;
  $('inv-issued').value = today();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  loadRules(); loadPeriod(); loadReminders();
}
