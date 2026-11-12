// Extra features: salary-day month, rollover/suggested budgets, rules, duplicates, goal auto-save,
// wishlist, repayables, invoices, warranties, reminders. Loaded by server.js.
const pad = n => String(n).padStart(2, '0');
let startDay = 1;                      // first day of your budget month (1-28)
let ctx = null;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const esc = s => String(s).replace(/[\\%_]/g, '\\$&');
const fail = (res, e) => res.status(500).json({ error: e.message });
const bad = (res, m) => res.status(400).json({ error: m });

function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return null;
  const [y, m] = month.split('-').map(Number), d = pad(startDay);
  return [`${month}-${d}`, `${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-${d}`];
}
function periodKey(dateStr) {          // which budget month a date belongs to
  let [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (d < startDay) { m--; if (!m) { m = 12; y--; } }
  return `${y}-${pad(m)}`;
}
const nextKey = k => { const [y, m] = k.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`; };

async function addCol(P, DB, t, c, def) {
  const [has] = await P.query('SELECT 1 FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?', [DB.name, t, c]);
  if (!has.length) await P.query(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
}
async function migrate(P, DB) {
  const T = {
    rules: 'id INT AUTO_INCREMENT PRIMARY KEY, pattern VARCHAR(100) NOT NULL, category VARCHAR(50) NOT NULL, tags VARCHAR(255) NULL',
    wishlist: 'id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, price DECIMAL(12,2) NOT NULL, note VARCHAR(255) NULL, bought TINYINT(1) NOT NULL DEFAULT 0',
    repayables: 'id INT AUTO_INCREMENT PRIMARY KEY, expense_id INT NOT NULL, who VARCHAR(100) NOT NULL, repaid_on DATE NULL, income_id INT NULL, INDEX (expense_id)',
    invoices: 'id INT AUTO_INCREMENT PRIMARY KEY, client VARCHAR(100) NOT NULL, number VARCHAR(40) NULL, amount DECIMAL(12,2) NOT NULL, issued_on DATE NOT NULL, due_on DATE NULL, paid_on DATE NULL, account_id INT NULL, income_id INT NULL, note VARCHAR(255) NULL',
    warranties: 'id INT AUTO_INCREMENT PRIMARY KEY, item VARCHAR(100) NOT NULL, bought_on DATE NULL, expires_on DATE NOT NULL, expense_id INT NULL, note VARCHAR(255) NULL',
  };
  for (const [n, d] of Object.entries(T)) await P.query(`CREATE TABLE IF NOT EXISTS ${n} (${d})`);
  for (const [t, c, d] of [['categories', 'rollover', 'TINYINT(1) NOT NULL DEFAULT 0'], ['goals', 'monthly_amount', 'DECIMAL(12,2) NULL'], ['goals', 'start_month', 'CHAR(7) NULL'], ['goal_log', 'auto_ym', 'CHAR(7) NULL']]) await addCol(P, DB, t, c, d);
  const [r] = await P.query("SELECT v FROM settings WHERE k='month_start_day'");
  startDay = r.length ? Math.min(28, Math.max(1, Number(r[0].v) || 1)) : 1;
}

async function effective(month) {      // budget per category incl. carry-over from earlier months
  const P = ctx.pool;
  const [cats] = await P.query('SELECT name, monthly_budget, rollover FROM categories WHERE monthly_budget IS NOT NULL');
  const [y, m] = month.split('-').map(Number), keys = [];
  for (let i = 12; i >= 0; i--) { const d = new Date(y, m - 1 - i, 1); keys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); }
  const [rows] = await P.query('SELECT category, spent_on, amount FROM expenses WHERE spent_on >= ? AND spent_on < ?', [monthRange(keys[0])[0], monthRange(month)[1]]);
  const spent = {};
  rows.forEach(r => { const k = periodKey(String(r.spent_on)); spent[r.category] = spent[r.category] || {}; spent[r.category][k] = (spent[r.category][k] || 0) + Number(r.amount); });
  const out = {};
  for (const c of cats) {
    const base = Number(c.monthly_budget); let carry = 0, started = false;
    for (const k of keys) {
      const eff = base + (c.rollover ? carry : 0), sp = (spent[c.name] || {})[k] || 0;
      if (sp > 0) started = true;                  // months before the first expense carry nothing
      if (k === month) out[c.name] = { base, carry: c.rollover ? Math.round(carry * 100) / 100 : 0, effective: Math.round(eff * 100) / 100, spent: sp, rollover: !!c.rollover };
      carry = started ? eff - sp : 0;
    }
  }
  return out;
}

async function runGoalAuto() {          // monthly auto-deposits for goals with a "set aside per month" amount
  const P = ctx.pool, cur = periodKey(ctx.localToday());
  const [goals] = await P.query('SELECT g.*, COALESCE((SELECT SUM(amount) FROM goal_log l WHERE l.goal_id = g.id), 0) AS saved FROM goals g WHERE g.monthly_amount > 0 AND g.start_month IS NOT NULL');
  for (const g of goals) {
    let ym = g.start_month, saved = Number(g.saved);
    for (let guard = 0; ym <= cur && guard < 240; guard++, ym = nextKey(ym)) {
      if (saved >= Number(g.target)) break;
      const [ex] = await P.query('SELECT 1 FROM goal_log WHERE goal_id=? AND auto_ym=?', [g.id, ym]);
      if (ex.length) continue;
      const amt = Math.min(Number(g.monthly_amount), Number(g.target) - saved);
      await P.query('INSERT INTO goal_log (goal_id, amount, logged_on, auto_ym) VALUES (?,?,?,?)', [g.id, amt, monthRange(ym)[0], ym]);
      saved += amt;
    }
  }
}

async function extraBackup() {
  const P = ctx.pool, out = {};
  for (const t of ['rules', 'wishlist', 'repayables', 'invoices', 'warranties']) out[t] = (await P.query(`SELECT * FROM ${t} ORDER BY id`))[0];
  return out;
}
async function extraRestore(conn, b) {
  const list = k => (Array.isArray(b[k]) ? b[k] : []), n = v => (v == null || v === '' ? null : Number(v)), s = (v, l) => (v == null ? null : String(v).slice(0, l));
  for (const t of ['rules', 'wishlist', 'repayables', 'invoices', 'warranties']) await conn.query(`DELETE FROM ${t}`);
  const put = async (t, cols, rows) => { if (rows.length) await conn.query(`INSERT INTO ${t} (${cols.join(',')}) VALUES ?`, [rows]); };
  await put('rules', ['id', 'pattern', 'category', 'tags'], list('rules').filter(r => r.pattern && r.category).map(r => [Number(r.id), s(r.pattern, 100), s(r.category, 50), s(r.tags, 255)]));
  await put('wishlist', ['id', 'name', 'price', 'note', 'bought'], list('wishlist').filter(r => r.name).map(r => [Number(r.id), s(r.name, 100), Number(r.price) || 0, s(r.note, 255), r.bought ? 1 : 0]));
  await put('repayables', ['id', 'expense_id', 'who', 'repaid_on', 'income_id'], list('repayables').map(r => [Number(r.id), Number(r.expense_id), s(r.who, 100) || '?', isDate(r.repaid_on) ? r.repaid_on : null, n(r.income_id)]));
  await put('invoices', ['id', 'client', 'number', 'amount', 'issued_on', 'due_on', 'paid_on', 'account_id', 'income_id', 'note'], list('invoices').filter(r => isDate(r.issued_on)).map(r => [Number(r.id), s(r.client, 100) || '?', s(r.number, 40), Number(r.amount) || 0, r.issued_on, isDate(r.due_on) ? r.due_on : null, isDate(r.paid_on) ? r.paid_on : null, n(r.account_id), n(r.income_id), s(r.note, 255)]));
  await put('warranties', ['id', 'item', 'bought_on', 'expires_on', 'expense_id', 'note'], list('warranties').filter(r => isDate(r.expires_on)).map(r => [Number(r.id), s(r.item, 100) || '?', isDate(r.bought_on) ? r.bought_on : null, r.expires_on, n(r.expense_id), s(r.note, 255)]));
}

function register(app, c) {
  ctx = c;
  const P = () => ctx.pool;
  setInterval(() => runGoalAuto().catch(() => {}), 6 * 3600 * 1000).unref();

  // ----- budget month (salary day) -----
  app.get('/api/settings/period', (req, res) => res.json({ start_day: startDay }));
  app.put('/api/settings/period', async (req, res) => {
    const d = Math.trunc(Number(req.body.start_day));
    if (!Number.isInteger(d) || d < 1 || d > 28) return bad(res, 'Choose a day from 1 to 28.');
    try { await P().query("INSERT INTO settings (k, v) VALUES ('month_start_day', ?) ON DUPLICATE KEY UPDATE v=VALUES(v)", [String(d)]); startDay = d; res.json({ start_day: d }); }
    catch (e) { fail(res, e); }
  });

  // ----- budgets -----
  app.get('/api/budgets/effective', async (req, res) => {
    if (!/^\d{4}-\d{2}$/.test(req.query.month || '')) return bad(res, 'Invalid month.');
    try { res.json(await effective(req.query.month)); } catch (e) { fail(res, e); }
  });
  app.put('/api/categories/:name/rollover', async (req, res) => {
    try { await P().query('UPDATE categories SET rollover=? WHERE name=?', [req.body.rollover ? 1 : 0, req.params.name]); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.get('/api/budgets/suggest', async (req, res) => {          // average of the last 3 complete budget months, +5%
    try {
      const cur = periodKey(ctx.localToday()), [y, m] = cur.split('-').map(Number), keys = [];
      for (let i = 3; i >= 1; i--) { const d = new Date(y, m - 1 - i, 1); keys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); }
      const [rows] = await P().query('SELECT category, SUM(amount) AS t FROM expenses WHERE spent_on >= ? AND spent_on < ? GROUP BY category', [monthRange(keys[0])[0], monthRange(cur)[0]]);
      const [cats] = await P().query('SELECT name, monthly_budget FROM categories');
      const cb = Object.fromEntries(cats.map(c => [c.name, c.monthly_budget == null ? null : Number(c.monthly_budget)]));
      res.json(rows.map(r => { const avg = Number(r.t) / 3; return { category: r.category, average: Math.round(avg * 100) / 100, suggested: Math.ceil(avg * 1.05 / 10) * 10, current: cb[r.category] ?? null }; }).filter(r => r.average > 0).sort((a, b) => b.average - a.average));
    } catch (e) { fail(res, e); }
  });

  // ----- auto-categorize rules -----
  app.get('/api/rules', async (req, res) => { try { res.json((await P().query('SELECT * FROM rules ORDER BY CHAR_LENGTH(pattern) DESC, id'))[0]); } catch (e) { fail(res, e); } });
  app.post('/api/rules', async (req, res) => {
    const pattern = String(req.body.pattern || '').trim().slice(0, 100), category = String(req.body.category || '').trim();
    if (pattern.length < 2) return bad(res, 'The text to look for needs at least 2 characters.');
    if (!category) return bad(res, 'Choose a category.');
    try {
      const cat = await ctx.canonCategory(category), tags = String(req.body.tags || '').split(',').map(t => t.trim().toLowerCase().replace(/[<>"'&]/g, '')).filter(Boolean).slice(0, 8).join(',') || null;
      await P().query('INSERT INTO rules (pattern, category, tags) VALUES (?,?,?)', [pattern, cat, tags]); res.status(201).json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/rules/:id', async (req, res) => { try { await P().query('DELETE FROM rules WHERE id=?', [req.params.id]); res.json({ ok: true }); } catch (e) { fail(res, e); } });
  app.post('/api/rules/apply', async (req, res) => {              // existing entries: only "Other" ones, or all if all=true
    try {
      const [rules] = await P().query('SELECT * FROM rules ORDER BY CHAR_LENGTH(pattern) DESC, id');
      let changed = 0; const done = new Set();
      for (const r of rules) {
        const [ids] = await P().query(`SELECT id FROM expenses WHERE title LIKE ? ${req.body.all ? '' : "AND category = 'Other'"}`, ['%' + esc(r.pattern) + '%']);
        const fresh = ids.map(x => x.id).filter(i => !done.has(i)); if (!fresh.length) continue;
        fresh.forEach(i => done.add(i));
        const [u] = await P().query('UPDATE expenses SET category=?, tags=COALESCE(NULLIF(tags, ""), ?) WHERE id IN (?) AND category <> ?', [r.category, r.tags, fresh, r.category]);
        changed += u.affectedRows;
      }
      res.json({ changed });
    } catch (e) { fail(res, e); }
  });

  // ----- duplicates -----
  app.get('/api/duplicates', async (req, res) => {
    try {
      const [g] = await P().query('SELECT GROUP_CONCAT(id ORDER BY id) AS ids FROM expenses GROUP BY spent_on, LOWER(title), amount HAVING COUNT(*) > 1 ORDER BY spent_on DESC LIMIT 100');
      const groups = g.map(r => ({ reason: 'Same date, title and amount', ids: r.ids.split(',').map(Number) }));
      const [t] = await P().query("SELECT id, note FROM expenses WHERE note LIKE '%TrxID:%'"), by = {};
      t.forEach(r => { const m = /TrxID:\s*([A-Za-z0-9]+)/.exec(r.note); if (m) (by[m[1].toUpperCase()] = by[m[1].toUpperCase()] || []).push(r.id); });
      Object.entries(by).filter(([, ids]) => ids.length > 1).forEach(([k, ids]) => { if (!groups.some(x => ids.every(i => x.ids.includes(i)))) groups.push({ reason: 'Same transaction ID ' + k, ids }); });
      const all = [...new Set(groups.flatMap(x => x.ids))];
      const items = all.length ? (await P().query('SELECT id, spent_on, title, amount, account_id, note FROM expenses WHERE id IN (?)', [all]))[0] : [];
      const m = Object.fromEntries(items.map(i => [i.id, i]));
      res.json(groups.map(x => ({ reason: x.reason, items: x.ids.map(i => m[i]).filter(Boolean) })));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/duplicates/merge', async (req, res) => {
    const keep = Number(req.body.keep), remove = (Array.isArray(req.body.remove) ? req.body.remove : []).map(Number).filter(i => Number.isInteger(i) && i > 0 && i !== keep);
    if (!Number.isInteger(keep) || !remove.length) return bad(res, 'Choose the entry to keep.');
    try {
      await P().query('UPDATE attachments SET expense_id=? WHERE expense_id IN (?)', [keep, remove]);   // receipts move to the kept entry
      const [r] = await P().query('DELETE FROM expenses WHERE id IN (?)', [remove]);
      res.json({ removed: r.affectedRows });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/expenses/recent', async (req, res) => {
    try { res.json((await P().query('SELECT id, spent_on, title, amount FROM expenses ORDER BY spent_on DESC, id DESC LIMIT 80'))[0]); } catch (e) { fail(res, e); }
  });

  // ----- goals: set aside each month -----
  app.put('/api/goals/:id/auto', async (req, res) => {
    const amt = req.body.monthly_amount === '' || req.body.monthly_amount == null ? null : Number(req.body.monthly_amount);
    if (amt !== null && (!Number.isFinite(amt) || amt < 0)) return bad(res, 'Monthly amount must be 0 or more.');
    try {
      await P().query('UPDATE goals SET monthly_amount=?, start_month=COALESCE(start_month, ?) WHERE id=?', [amt || null, periodKey(ctx.localToday()), req.params.id]);
      await runGoalAuto(); res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  // ----- wishlist -----
  app.get('/api/wishlist', async (req, res) => { try { res.json((await P().query('SELECT * FROM wishlist ORDER BY bought, id DESC'))[0]); } catch (e) { fail(res, e); } });
  app.post('/api/wishlist', async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 100), price = Number(req.body.price);
    if (!name) return bad(res, 'Enter what you want.'); if (!Number.isFinite(price) || price <= 0) return bad(res, 'Price must be greater than 0.');
    try { await P().query('INSERT INTO wishlist (name, price, note) VALUES (?,?,?)', [name, price, req.body.note ? String(req.body.note).slice(0, 255) : null]); res.status(201).json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.put('/api/wishlist/:id', async (req, res) => { try { await P().query('UPDATE wishlist SET bought=? WHERE id=?', [req.body.bought ? 1 : 0, req.params.id]); res.json({ ok: true }); } catch (e) { fail(res, e); } });
  app.delete('/api/wishlist/:id', async (req, res) => { try { await P().query('DELETE FROM wishlist WHERE id=?', [req.params.id]); res.json({ ok: true }); } catch (e) { fail(res, e); } });

  // ----- money others owe you for an expense -----
  app.get('/api/repayables', async (req, res) => {
    try { res.json((await P().query(`SELECT r.*, e.title, e.amount, e.spent_on FROM repayables r LEFT JOIN expenses e ON e.id = r.expense_id ORDER BY r.repaid_on IS NOT NULL, r.id DESC`))[0]); } catch (e) { fail(res, e); }
  });
  app.post('/api/repayables', async (req, res) => {
    const eid = Number(req.body.expense_id), who = String(req.body.who || '').trim().slice(0, 100);
    if (!Number.isInteger(eid) || eid < 1) return bad(res, 'Choose the expense.'); if (!who) return bad(res, 'Enter who will repay it.');
    try {
      const [[e]] = await P().query('SELECT COUNT(*) AS n FROM expenses WHERE id=?', [eid]); if (!e.n) return bad(res, 'Expense not found.');
      await P().query('INSERT INTO repayables (expense_id, who) VALUES (?,?)', [eid, who]); res.status(201).json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/repayables/:id/repaid', async (req, res) => {
    try {
      const [[r]] = await P().query('SELECT r.*, e.title, e.amount FROM repayables r JOIN expenses e ON e.id = r.expense_id WHERE r.id=?', [req.params.id]);
      if (!r) return bad(res, 'Not found.'); if (r.repaid_on) return bad(res, 'Already marked as repaid.');
      const on = isDate(req.body.date) ? req.body.date : ctx.localToday();
      const [i] = await P().query('INSERT INTO income (received_on, source, amount, note, account_id) VALUES (?,?,?,?,?)', [on, `Repaid by ${r.who}`, r.amount, `For: ${r.title}`, ctx.accId(req.body.account_id)]);
      await P().query('UPDATE repayables SET repaid_on=?, income_id=? WHERE id=?', [on, i.insertId, r.id]); res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/repayables/:id/unpaid', async (req, res) => {
    try {
      const [[r]] = await P().query('SELECT income_id FROM repayables WHERE id=?', [req.params.id]);
      if (r && r.income_id) await P().query('DELETE FROM income WHERE id=?', [r.income_id]);
      await P().query('UPDATE repayables SET repaid_on=NULL, income_id=NULL WHERE id=?', [req.params.id]); res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/repayables/:id', async (req, res) => { try { await P().query('DELETE FROM repayables WHERE id=?', [req.params.id]); res.json({ ok: true }); } catch (e) { fail(res, e); } });

  // ----- invoices -----
  const invStatus = (r, today) => r.paid_on ? 'paid' : r.due_on && String(r.due_on) < today ? 'overdue' : r.due_on && String(r.due_on) <= addDays(today, 7) ? 'due soon' : 'pending';
  const addDays = (d, n) => { const t = new Date(d + 'T00:00:00'); t.setDate(t.getDate() + n); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
  app.get('/api/invoices', async (req, res) => {
    try { const t = ctx.localToday(); res.json((await P().query('SELECT * FROM invoices ORDER BY paid_on IS NOT NULL, due_on, id DESC'))[0].map(r => ({ ...r, status: invStatus(r, t) }))); } catch (e) { fail(res, e); }
  });
  app.post('/api/invoices', async (req, res) => {
    const b = req.body, amount = Number(b.amount), client = String(b.client || '').trim().slice(0, 100);
    if (!client) return bad(res, 'Enter the client.'); if (!Number.isFinite(amount) || amount <= 0) return bad(res, 'Amount must be greater than 0.');
    if (!isDate(b.issued_on)) return bad(res, 'Enter the issue date.'); if (b.due_on && !isDate(b.due_on)) return bad(res, 'Invalid due date.');
    try {
      await P().query('INSERT INTO invoices (client, number, amount, issued_on, due_on, account_id, note) VALUES (?,?,?,?,?,?,?)',
        [client, b.number ? String(b.number).slice(0, 40) : null, amount, b.issued_on, b.due_on || null, ctx.accId(b.account_id), b.note ? String(b.note).slice(0, 255) : null]);
      res.status(201).json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/invoices/:id/paid', async (req, res) => {
    try {
      const [[r]] = await P().query('SELECT * FROM invoices WHERE id=?', [req.params.id]);
      if (!r) return bad(res, 'Not found.'); if (r.paid_on) return bad(res, 'Already paid.');
      const on = isDate(req.body.date) ? req.body.date : ctx.localToday(), acct = ctx.accId(req.body.account_id) || r.account_id;
      const [i] = await P().query('INSERT INTO income (received_on, source, amount, note, account_id) VALUES (?,?,?,?,?)', [on, `Invoice ${r.number ? '#' + r.number + ' ' : ''}- ${r.client}`, r.amount, r.note, acct]);
      await P().query('UPDATE invoices SET paid_on=?, income_id=?, account_id=? WHERE id=?', [on, i.insertId, acct, r.id]); res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/invoices/:id/unpaid', async (req, res) => {
    try {
      const [[r]] = await P().query('SELECT income_id FROM invoices WHERE id=?', [req.params.id]);
      if (r && r.income_id) await P().query('DELETE FROM income WHERE id=?', [r.income_id]);
      await P().query('UPDATE invoices SET paid_on=NULL, income_id=NULL WHERE id=?', [req.params.id]); res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/invoices/:id', async (req, res) => { try { await P().query('DELETE FROM invoices WHERE id=?', [req.params.id]); res.json({ ok: true }); } catch (e) { fail(res, e); } });

  // ----- warranties -----
  app.get('/api/warranties', async (req, res) => {
    try {
      const t = new Date(ctx.localToday() + 'T00:00:00');
      res.json((await P().query('SELECT w.*, e.title AS expense_title FROM warranties w LEFT JOIN expenses e ON e.id = w.expense_id ORDER BY w.expires_on'))[0].map(w => ({ ...w, days_left: Math.round((new Date(String(w.expires_on) + 'T00:00:00') - t) / 864e5) })));
    } catch (e) { fail(res, e); }
  });
  app.post('/api/warranties', async (req, res) => {
    const item = String(req.body.item || '').trim().slice(0, 100);
    if (!item) return bad(res, 'Enter the item.'); if (!isDate(req.body.expires_on)) return bad(res, 'Enter the warranty end date.');
    try {
      await P().query('INSERT INTO warranties (item, bought_on, expires_on, expense_id, note) VALUES (?,?,?,?,?)', [item, isDate(req.body.bought_on) ? req.body.bought_on : null, req.body.expires_on, ctx.accId(req.body.expense_id), req.body.note ? String(req.body.note).slice(0, 255) : null]);
      res.status(201).json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/warranties/:id', async (req, res) => { try { await P().query('DELETE FROM warranties WHERE id=?', [req.params.id]); res.json({ ok: true }); } catch (e) { fail(res, e); } });

  // ----- reminders for invoices and warranties -----
  app.get('/api/reminders/extra', async (req, res) => {
    try {
      const today = ctx.localToday(), soon = addDays(today, 30), t = new Date(today + 'T00:00:00');
      const [w] = await P().query('SELECT item, expires_on FROM warranties WHERE expires_on >= ? AND expires_on <= ? ORDER BY expires_on', [today, soon]);
      const [inv] = await P().query('SELECT client, number, amount, due_on FROM invoices WHERE paid_on IS NULL AND due_on IS NOT NULL AND due_on <= ? ORDER BY due_on', [addDays(today, 7)]);
      const days = d => Math.round((new Date(String(d) + 'T00:00:00') - t) / 864e5);
      res.json({ warranties: w.map(x => ({ item: x.item, days: days(x.expires_on), date: x.expires_on })), invoices: inv.map(x => ({ client: x.client, number: x.number, amount: x.amount, days: days(x.due_on) })) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { register, migrate, monthRange, periodKey, extraBackup, extraRestore, runGoalAuto };
