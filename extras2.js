// More features: bulk edit, import presets, projects/clients, assets & debts, low-balance alerts, what-if data,
// claim sheets, data health check, status page, quick PIN. Loaded by server.js.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const pad = n => String(n).padStart(2, '0');
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const bad = (res, m) => res.status(400).json({ error: m });
const fail = (res, e) => res.status(500).json({ error: e.message });
const num = v => (v === '' || v == null ? null : Number(v));
let ctx = null, pinHash = null, pinFails = 0, lastFull = 0;
const PIN_DAYS = 14;                           // the PIN works for 14 days after your last full password sign-in

const scrypt = (s, salt) => crypto.scryptSync(String(s), salt, 64);
const hashPin = pin => { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + scrypt(pin, salt).toString('hex'); };
const checkPin = (pin, stored) => { const [s, h] = stored.split(':'); return crypto.timingSafeEqual(scrypt(pin, Buffer.from(s, 'hex')), Buffer.from(h, 'hex')); };
const normTags = v => [...new Set(String(v || '').split(',').map(t => t.trim().toLowerCase().replace(/[<>"'&]/g, '').slice(0, 30)).filter(Boolean))].slice(0, 8).join(',') || null;
const folderSize = dir => { try { return fs.readdirSync(dir).reduce((s, f) => { try { return s + fs.statSync(path.join(dir, f)).size; } catch { return s; } }, 0); } catch { return 0; } };

async function migrate(P) {
  const T = {
    project_links: "kind VARCHAR(10) NOT NULL, ref_id INT NOT NULL, project VARCHAR(60) NOT NULL, PRIMARY KEY (kind, ref_id), INDEX (project)",
    assets: "id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, kind VARCHAR(12) NOT NULL, qty DECIMAL(14,4) NULL, unit VARCHAR(12) NULL, unit_price DECIMAL(14,2) NULL, value DECIMAL(14,2) NOT NULL, note VARCHAR(255) NULL",
    asset_log: "id INT AUTO_INCREMENT PRIMARY KEY, asset_id INT NOT NULL, on_date DATE NOT NULL, value DECIMAL(14,2) NOT NULL, INDEX (asset_id)",
    account_alerts: "account_id INT PRIMARY KEY, min_balance DECIMAL(12,2) NOT NULL",
    import_presets: "id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(60) NOT NULL, data TEXT NOT NULL",
  };
  for (const [n, d] of Object.entries(T)) await P.query(`CREATE TABLE IF NOT EXISTS ${n} (${d})`);
  const [r] = await P.query("SELECT k, v FROM settings WHERE k IN ('pin_hash','pin_last_full')");
  const m = Object.fromEntries(r.map(x => [x.k, x.v]));
  pinHash = m.pin_hash || null; lastFull = Number(m.pin_last_full) || 0;
}
function noteFullLogin() {                       // called by server.js after a successful password sign-in
  lastFull = Date.now(); pinFails = 0;
  if (ctx && ctx.pool) ctx.pool.query("INSERT INTO settings (k, v) VALUES ('pin_last_full', ?) ON DUPLICATE KEY UPDATE v=VALUES(v)", [String(lastFull)]).catch(() => {});
}
const pinAvailable = () => !!pinHash && pinFails < 5 && Date.now() - lastFull < PIN_DAYS * 864e5;

const TABLES = ['project_links', 'assets', 'asset_log', 'account_alerts', 'import_presets'];
async function extraBackup() { const out = {}; for (const t of TABLES) out[t] = (await ctx.pool.query(`SELECT * FROM ${t}`))[0]; return out; }
async function extraRestore(conn, b) {
  const list = k => (Array.isArray(b[k]) ? b[k] : []), s = (v, l) => (v == null ? null : String(v).slice(0, l));
  for (const t of TABLES) await conn.query(`DELETE FROM ${t}`);
  const put = async (t, cols, rows) => { if (rows.length) await conn.query(`INSERT INTO ${t} (${cols.join(',')}) VALUES ?`, [rows]); };
  await put('project_links', ['kind', 'ref_id', 'project'], list('project_links').filter(r => ['expense', 'income'].includes(r.kind) && r.project).map(r => [r.kind, Number(r.ref_id), s(r.project, 60)]));
  await put('assets', ['id', 'name', 'kind', 'qty', 'unit', 'unit_price', 'value', 'note'], list('assets').filter(r => r.name).map(r => [Number(r.id), s(r.name, 100), s(r.kind, 12) || 'other', num(r.qty), s(r.unit, 12), num(r.unit_price), Number(r.value) || 0, s(r.note, 255)]));
  await put('asset_log', ['id', 'asset_id', 'on_date', 'value'], list('asset_log').filter(r => isDate(r.on_date)).map(r => [Number(r.id), Number(r.asset_id), r.on_date, Number(r.value) || 0]));
  await put('account_alerts', ['account_id', 'min_balance'], list('account_alerts').map(r => [Number(r.account_id), Number(r.min_balance) || 0]));
  await put('import_presets', ['id', 'name', 'data'], list('import_presets').filter(r => r.name && r.data).map(r => [Number(r.id), s(r.name, 60), s(r.data, 20000)]));
}

function register(app, c) {
  ctx = c; const P = () => ctx.pool;

  // ----- recent activity feed (expenses, income, transfers) for the Overview and the side panel -----
  app.get('/api/activity', async (req, res) => {
    try {
      const [rows] = await P().query(`
        SELECT * FROM (
          SELECT 'expense' AS kind, id, spent_on AS dt, title, category AS sub, -amount AS amt, account_id FROM expenses
          UNION ALL SELECT 'income', id, received_on, source, 'Income', amount, account_id FROM income
          UNION ALL SELECT 'transfer', t.id, t.moved_on, CONCAT(f.name, ' to ', d.name), 'Transfer', t.amount, NULL FROM transfers t JOIN accounts f ON f.id = t.from_id JOIN accounts d ON d.id = t.to_id
        ) a ORDER BY dt DESC, id DESC LIMIT 14`);
      res.json(rows.map(r => ({ ...r, amt: Number(r.amt) })));
    } catch (e) { fail(res, e); }
  });

  // ----- one account's dashboard: balance, cash in / out, card limit and due date, filters, breakdown, comparison, export -----
  const prevKey = k => { const [y, m] = k.split('-').map(Number), d = new Date(y, m - 2, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  async function accountView(id, o) {
    const [[a]] = await P().query('SELECT * FROM accounts WHERE id=?', [id]);
    if (!a) return null;
    const bal = (await ctx.balances()).find(b => b.id === id), balance = Number(bal ? bal.balance : 0), card = a.type === 'card', r2 = v => Math.round(v * 100) / 100;
    // every entry that touches this account, newest first (transfer fees are expenses, so they show up here too)
    const [rows] = await P().query(`SELECT * FROM (
        SELECT 'income' AS kind, id, received_on AS dt, source AS label, 'Income' AS sub, amount AS delta, note FROM income WHERE account_id=?
        UNION ALL SELECT 'expense', id, spent_on, title, category, -amount, note FROM expenses WHERE account_id=?
        UNION ALL SELECT 'transfer', t.id, t.moved_on, CONCAT('Transfer to ', ta.name), 'Transfer', -t.amount, t.note FROM transfers t JOIN accounts ta ON ta.id = t.to_id WHERE t.from_id=?
        UNION ALL SELECT 'transfer', t.id, t.moved_on, CONCAT('Transfer from ', tb.name), 'Transfer', t.amount, t.note FROM transfers t JOIN accounts tb ON tb.id = t.from_id WHERE t.to_id=?
      ) x ORDER BY dt DESC, id DESC`, [id, id, id, id]);
    const cur = ctx.periodKey(ctx.localToday()), prev = prevKey(cur), mr = ctx.monthRange(cur), pr = ctx.monthRange(prev);
    const totals = { in: 0, out: 0, in_month: 0, out_month: 0 }, cmp = { cur: { in: 0, out: 0 }, prev: { in: 0, out: 0 } }, catCur = {}, catPrev = {};
    const [y, m] = cur.split('-').map(Number), keys = [];
    for (let i = 5; i >= 0; i--) { const d = new Date(y, m - 1 - i, 1); keys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); }
    const monthly = Object.fromEntries(keys.map(k => [k, { ym: k, in: 0, out: 0 }]));
    let run = balance;
    const all = rows.map(r => {                         // balance right after each entry, over the whole history (so filters never change it)
      const d = Number(r.delta), dt = String(r.dt).slice(0, 10), k = d > 0 ? 'in' : 'out', abs = Math.abs(d);
      totals[k] += abs; if (dt >= mr[0] && dt < mr[1]) totals[k + '_month'] += abs;
      const pk = ctx.periodKey(dt); if (monthly[pk]) monthly[pk][k] += abs;
      if (pk === cur) { cmp.cur[k] += abs; if (r.kind === 'expense') catCur[r.sub] = (catCur[r.sub] || 0) + abs; }
      if (pk === prev) { cmp.prev[k] += abs; if (r.kind === 'expense') catPrev[r.sub] = (catPrev[r.sub] || 0) + abs; }
      const out = { kind: r.kind, id: r.id, date: dt, label: r.label, sub: r.sub, note: r.note, delta: d, balance_after: r2(run) }; run -= d; return out;
    });
    // filters: date range, text search (details, category, note, or an exact amount) and direction
    const from = isDate(o.from) ? o.from : null, to = isDate(o.to) ? o.to : null, q = String(o.q || '').trim().toLowerCase().slice(0, 60), dir = ['in', 'out'].includes(o.dir) ? o.dir : 'all', qn = /^\d+(\.\d+)?$/.test(q) ? Number(q) : null;
    const filtered = all.filter(r => (!from || r.date >= from) && (!to || r.date <= to) && (dir === 'all' || (dir === 'in' ? r.delta > 0 : r.delta < 0))
      && (!q || [r.label, r.sub, r.note].some(t => String(t || '').toLowerCase().includes(q)) || (qn !== null && Math.abs(r.delta) === qn)));
    const f = { count: filtered.length, in: 0, out: 0 }; filtered.forEach(r => { f[r.delta > 0 ? 'in' : 'out'] += Math.abs(r.delta); });
    // spent by category: for the chosen dates, otherwise for this budget month
    const useRange = !!(from || to), bs = useRange ? from : mr[0], be = useRange ? to : null, byCat = {};
    all.filter(r => r.kind === 'expense' && (useRange ? ((!from || r.date >= from) && (!to || r.date <= to)) : (r.date >= mr[0] && r.date < mr[1]))).forEach(r => { const c = byCat[r.sub] = byCat[r.sub] || { category: r.sub, total: 0, count: 0 }; c.total += Math.abs(r.delta); c.count++; });
    const catTotal = Object.values(byCat).reduce((s, c) => s + c.total, 0);
    const breakdown = { label: useRange ? 'Selected dates' : 'This month', total: r2(catTotal), items: Object.values(byCat).sort((x, y2) => y2.total - x.total).map(c => ({ ...c, total: r2(c.total), pct: catTotal ? Math.round(c.total / catTotal * 100) : 0 })) };
    const movers = [...new Set([...Object.keys(catCur), ...Object.keys(catPrev)])].map(c => ({ category: c, cur: r2(catCur[c] || 0), prev: r2(catPrev[c] || 0), change: r2((catCur[c] || 0) - (catPrev[c] || 0)) })).sort((x, y2) => Math.abs(y2.change) - Math.abs(x.change)).slice(0, 5);
    let due = null;
    if (card && a.due_day) {
      const t = new Date(ctx.localToday() + 'T00:00:00'); let best = null;
      for (const off of [0, 1]) { const first = new Date(t.getFullYear(), t.getMonth() + off, 1), last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(), d = new Date(first.getFullYear(), first.getMonth(), Math.min(a.due_day, last)); if (d >= t) { best = d; break; } }
      if (best) due = { date: `${best.getFullYear()}-${pad(best.getMonth() + 1)}-${pad(best.getDate())}`, days_left: Math.round((best - t) / 864e5) };
    }
    const alert = (await P().query('SELECT min_balance FROM account_alerts WHERE account_id=?', [id]))[0][0];
    const spentMonth = Number((await P().query('SELECT COALESCE(SUM(amount),0) AS t FROM expenses WHERE account_id=? AND spent_on >= ? AND spent_on < ?', [id, mr[0], mr[1]]))[0][0].t);
    const owed = card ? Math.max(0, -balance) : null, limit = a.credit_limit == null ? null : Number(a.credit_limit);
    const net = x => r2(x.in - x.out), pct = (c, p) => (p ? Math.round((c - p) / p * 100) : null);
    return {
      account: { id: a.id, name: a.name, type: a.type, provider: a.provider, acct_no: a.acct_no, archived: !!a.archived, credit_limit: limit, due_day: a.due_day, monthly_limit: a.monthly_limit == null ? null : Number(a.monthly_limit), reconciled_on: a.reconciled_on, min_balance: alert ? Number(alert.min_balance) : null },
      balance: r2(balance), owed: owed == null ? null : r2(owed), available: card && limit != null ? r2(limit - owed) : null, utilization: card && limit ? Math.round(owed / limit * 100) : null, due,
      totals: { in: r2(totals.in), out: r2(totals.out), in_month: r2(totals.in_month), out_month: r2(totals.out_month) }, spent_month: r2(spentMonth), month_range: mr,
      monthly: keys.map(k => ({ ym: k, in: r2(monthly[k].in), out: r2(monthly[k].out) })),
      compare: { cur_label: cur, prev_label: prev, cur: { in: r2(cmp.cur.in), out: r2(cmp.cur.out), net: net(cmp.cur) }, prev: { in: r2(cmp.prev.in), out: r2(cmp.prev.out), net: net(cmp.prev) },
        change: { in: pct(cmp.cur.in, cmp.prev.in), out: pct(cmp.cur.out, cmp.prev.out) }, categories: movers },
      breakdown, filter: { from, to, q, dir, count: f.count, in: r2(f.in), out: r2(f.out) },
      rows: filtered, recent: filtered.slice(0, o.limit), total_entries: all.length, filtered_entries: filtered.length,
    };
  }
  const viewOpts = req => ({ from: req.query.from, to: req.query.to, q: req.query.q, dir: req.query.dir, limit: Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit)) || 15)) });
  app.get('/api/accounts/:id/summary', async (req, res) => {
    try {
      const v = await accountView(Number(req.params.id), viewOpts(req));
      if (!v) return res.status(404).json({ error: 'Account not found.' });
      delete v.rows; res.json(v);
    } catch (e) { fail(res, e); }
  });
  app.get('/api/accounts/:id/export.xlsx', async (req, res) => {      // the account's transactions (with the same filters) as an Excel file
    let ExcelJS; try { ExcelJS = require('exceljs'); } catch { return bad(res, 'Excel export needs one more install step: stop the app, run "npm install", then start it again.'); }
    try {
      const v = await accountView(Number(req.params.id), { ...viewOpts(req), limit: 1e9 });
      if (!v) return res.status(404).json({ error: 'Account not found.' });
      const a = v.account, card = a.type === 'card', wb = new ExcelJS.Workbook(); wb.creator = 'Personal Expense Tracker';
      const MONEY = '#,##0.00', styleHead = ws => { ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5B3DF5' } }; };
      const sum = wb.addWorksheet('Summary'); sum.columns = [{ width: 30 }, { width: 28 }];
      const f = v.filter, desc = [f.from && `from ${f.from}`, f.to && `to ${f.to}`, f.q && `containing "${f.q}"`, f.dir !== 'all' && (f.dir === 'in' ? 'cash in only' : 'cash out only')].filter(Boolean).join(', ') || 'all transactions';
      const lines = [['Account', a.name], ['Type', ({ bank: 'Bank account', mfs: 'Mobile wallet', cash: 'Cash', card: 'Credit card' })[a.type]], ['Bank / wallet', a.provider || ''], ['Number (last digits)', a.acct_no || ''],
        [card ? 'Balance owed' : 'Balance', card ? v.owed : v.balance], ...(card ? [['Credit limit', v.account.credit_limit], ['Available credit', v.available], ['Payment due', v.due ? v.due.date : '']] : []),
        ['Total cash in (all time)', v.totals.in], ['Total cash out (all time)', v.totals.out], ['Cash in this month', v.totals.in_month], ['Cash out this month', v.totals.out_month], ['', ''], ['Rows below', desc], ['Rows shown', f.count], ['Cash in (rows shown)', f.in], ['Cash out (rows shown)', f.out], ['Created', ctx.localToday()]];
      lines.forEach(l => { const r = sum.addRow(l); r.getCell(1).font = { bold: true }; if (typeof l[1] === 'number') r.getCell(2).numFmt = MONEY; });
      const ws = wb.addWorksheet('Transactions', { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = [['Date', 12], ['Type', 11], ['Details', 32], ['Category', 18], ['Note', 30], ['Cash in', 14], ['Cash out', 14], [card ? 'Balance after (negative = owed)' : 'Balance after', 22]].map(([h, w], i) => ({ header: h, width: w, style: i >= 5 ? { numFmt: MONEY } : i === 0 ? { numFmt: 'yyyy-mm-dd' } : {} })); styleHead(ws);
      const dateOf = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); };
      [...v.rows].reverse().forEach(r => ws.addRow([dateOf(r.date), r.kind === 'transfer' ? 'Transfer' : r.kind === 'income' ? 'Income' : 'Expense', r.label, r.kind === 'expense' ? r.sub : '', r.note || '', r.delta > 0 ? r.delta : null, r.delta < 0 ? -r.delta : null, r.balance_after]));
      if (v.rows.length) { const n = v.rows.length + 1, t = ws.addRow(['', '', 'Total', '', '', { formula: `SUM(F2:F${n})` }, { formula: `SUM(G2:G${n})` }, '']); t.font = { bold: true }; ws.autoFilter = 'A1:H1'; }
      const bc = wb.addWorksheet('By category'); bc.columns = [{ header: 'Category', width: 24 }, { header: 'Spent', width: 14, style: { numFmt: MONEY } }, { header: 'Entries', width: 10 }, { header: 'Share', width: 10, style: { numFmt: '0%' } }]; styleHead(bc);
      v.breakdown.items.forEach(c => bc.addRow([c.category, c.total, c.count, c.pct / 100])); bc.addRow([`(${v.breakdown.label})`, '', '', '']).font = { italic: true };
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${String(a.name).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'account'}-${ctx.localToday()}.xlsx"`);
      await wb.xlsx.write(res); res.end();
    } catch (e) { if (!res.headersSent) fail(res, e); else res.end(); }
  });

  // ----- bulk edit expenses -----
  app.post('/api/bulk/expenses', async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(i => Number.isInteger(i) && i > 0))].slice(0, 500);
    if (!ids.length) return bad(res, 'Select at least one expense.');
    try {
      if (req.body.delete) {
        const [items] = await P().query('SELECT * FROM expenses WHERE id IN (?)', [ids]);
        await ctx.trashExpenses(ids);
        return res.json({ deleted: items.length, items });
      }
      const b = req.body; let updated = 0;
      const cat = b.category ? await ctx.canonCategory(b.category) : null, add = normTags(b.add_tags);
      let acct; if ('account_id' in b && b.account_id !== '' && b.account_id != null) {
        if (b.account_id === 'none') acct = null;
        else { acct = ctx.accId(b.account_id); const [[a]] = await P().query('SELECT COUNT(*) AS n FROM accounts WHERE id=?', [acct]); if (!acct || !a.n) return bad(res, 'Account not found.'); }
      }
      const [rows] = await P().query('SELECT id, tags FROM expenses WHERE id IN (?)', [ids]);
      for (const r of rows) {
        const sets = [], vals = [];
        if (cat) { sets.push('category=?'); vals.push(cat); }
        if (add) { sets.push('tags=?'); vals.push(normTags([r.tags, add].filter(Boolean).join(','))); }
        if (acct !== undefined) { sets.push('account_id=?'); vals.push(acct); }
        if (sets.length) { await P().query(`UPDATE expenses SET ${sets.join(', ')} WHERE id=?`, [...vals, r.id]); updated++; }
      }
      if (typeof b.project === 'string' && b.project.trim()) {
        const pr = b.project.trim().slice(0, 60);
        for (const r of rows) await P().query('INSERT INTO project_links (kind, ref_id, project) VALUES (?,?,?) ON DUPLICATE KEY UPDATE project=VALUES(project)', ['expense', r.id, pr]);
        updated = updated || rows.length;
      }
      res.json({ updated });
    } catch (e) { fail(res, e); }
  });

  // ----- projects / clients -----
  app.post('/api/projects/link', async (req, res) => {
    const kind = req.body.kind, ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(i => Number.isInteger(i) && i > 0).slice(0, 500), pr = String(req.body.project || '').trim().slice(0, 60);
    if (!['expense', 'income'].includes(kind) || !ids.length) return bad(res, 'Nothing to link.');
    try {
      if (!pr) await P().query('DELETE FROM project_links WHERE kind=? AND ref_id IN (?)', [kind, ids]);
      else for (const id of ids) await P().query('INSERT INTO project_links (kind, ref_id, project) VALUES (?,?,?) ON DUPLICATE KEY UPDATE project=VALUES(project)', [kind, id, pr]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/projects/links', async (req, res) => {
    const ids = String(req.query.ids || '').split(',').map(Number).filter(i => Number.isInteger(i) && i > 0).slice(0, 500);
    if (!['expense', 'income'].includes(req.query.kind) || !ids.length) return res.json({});
    try { const [r] = await P().query('SELECT ref_id, project FROM project_links WHERE kind=? AND ref_id IN (?)', [req.query.kind, ids]); res.json(Object.fromEntries(r.map(x => [x.ref_id, x.project]))); } catch (e) { fail(res, e); }
  });
  app.get('/api/projects', async (req, res) => {
    try {
      const m = new Map(), row = p => { const k = p.toLowerCase(); if (!m.has(k)) m.set(k, { project: p, income: 0, income_n: 0, expenses: 0, expense_n: 0 }); return m.get(k); };
      (await P().query("SELECT pl.project, SUM(e.amount) AS t, COUNT(*) AS n FROM project_links pl JOIN expenses e ON pl.kind='expense' AND e.id = pl.ref_id GROUP BY pl.project"))[0].forEach(r => { const x = row(r.project); x.expenses += Number(r.t); x.expense_n += r.n; });
      (await P().query("SELECT pl.project, SUM(i.amount) AS t, COUNT(*) AS n FROM project_links pl JOIN income i ON pl.kind='income' AND i.id = pl.ref_id GROUP BY pl.project"))[0].forEach(r => { const x = row(r.project); x.income += Number(r.t); x.income_n += r.n; });
      // paid invoices count towards their client unless that income was linked to a project by hand
      (await P().query("SELECT v.client AS project, SUM(n.amount) AS t, COUNT(*) AS n FROM invoices v JOIN income n ON n.id = v.income_id WHERE v.paid_on IS NOT NULL AND NOT EXISTS (SELECT 1 FROM project_links p WHERE p.kind='income' AND p.ref_id = n.id) GROUP BY v.client"))[0].forEach(r => { const x = row(r.project); x.income += Number(r.t); x.income_n += r.n; });
      res.json([...m.values()].map(x => ({ ...x, profit: Math.round((x.income - x.expenses) * 100) / 100 })).sort((a, b) => b.profit - a.profit));
    } catch (e) { fail(res, e); }
  });
  app.get('/api/claim', async (req, res) => {          // expenses for a claim sheet, with their receipts
    try {
      const w = ['1=1'], v = [];
      if (isDate(req.query.from)) { w.push('e.spent_on >= ?'); v.push(req.query.from); }
      if (isDate(req.query.to)) { w.push('e.spent_on <= ?'); v.push(req.query.to); }
      if (req.query.tag) { w.push('FIND_IN_SET(?, e.tags)'); v.push(String(req.query.tag).toLowerCase().slice(0, 30)); }
      if (req.query.project) { w.push("EXISTS (SELECT 1 FROM project_links p WHERE p.kind='expense' AND p.ref_id = e.id AND p.project = ?)"); v.push(String(req.query.project).slice(0, 60)); }
      const [rows] = await P().query(`SELECT e.id, e.spent_on, e.title, e.category, e.amount, e.note, e.tags FROM expenses e WHERE ${w.join(' AND ')} ORDER BY e.spent_on, e.id LIMIT 300`, v);
      const att = rows.length ? (await P().query('SELECT id, expense_id, filename, mime FROM attachments WHERE expense_id IN (?) ORDER BY id', [rows.map(r => r.id)]))[0] : [];
      res.json(rows.map(r => ({ ...r, receipts: att.filter(a => a.expense_id === r.id) })));
    } catch (e) { fail(res, e); }
  });

  // ----- import presets -----
  app.get('/api/presets', async (req, res) => { try { res.json((await P().query('SELECT id, name, data FROM import_presets ORDER BY name'))[0]); } catch (e) { fail(res, e); } });
  app.post('/api/presets', async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name || typeof req.body.data !== 'object') return bad(res, 'Give the setup a name.');
    try {
      await P().query('DELETE FROM import_presets WHERE name=?', [name]);
      await P().query('INSERT INTO import_presets (name, data) VALUES (?,?)', [name, JSON.stringify(req.body.data).slice(0, 20000)]); res.status(201).json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/presets/:id', async (req, res) => { try { await P().query('DELETE FROM import_presets WHERE id=?', [req.params.id]); res.json({ ok: true }); } catch (e) { fail(res, e); } });

  // ----- average monthly spending per category (what-if) -----
  app.get('/api/spend/avg', async (req, res) => {
    try {
      const n = Math.min(12, Math.max(1, Math.trunc(Number(req.query.months)) || 6)), cur = ctx.periodKey(ctx.localToday()), [y, m] = cur.split('-').map(Number), first = new Date(y, m - 1 - n, 1);
      const a = `${first.getFullYear()}-${pad(first.getMonth() + 1)}`;
      const [r] = await P().query('SELECT category, SUM(amount) AS t FROM expenses WHERE spent_on >= ? AND spent_on < ? GROUP BY category ORDER BY t DESC', [ctx.monthRange(a)[0], ctx.monthRange(cur)[0]]);
      res.json({ months: n, categories: r.map(x => ({ category: x.category, monthly: Math.round(Number(x.t) / n * 100) / 100 })) });
    } catch (e) { fail(res, e); }
  });

  // ----- other assets & debts (they join your net worth) -----
  const KINDS = ['gold', 'land', 'vehicle', 'property', 'investment', 'other', 'debt'];
  app.get('/api/assets', async (req, res) => {
    try {
      const rows = (await P().query('SELECT * FROM assets ORDER BY kind = "debt", id'))[0];
      res.json({ items: rows, assets_total: rows.filter(r => r.kind !== 'debt').reduce((s, r) => s + Number(r.value), 0), debts_total: rows.filter(r => r.kind === 'debt').reduce((s, r) => s + Number(r.value), 0) });
    } catch (e) { fail(res, e); }
  });
  app.post('/api/assets', async (req, res) => {
    const b = req.body, name = String(b.name || '').trim().slice(0, 100), qty = num(b.qty), up = num(b.unit_price);
    let value = num(b.value); if (qty != null && up != null) value = Math.round(qty * up * 100) / 100;
    if (!name) return bad(res, 'Enter a name.'); if (!KINDS.includes(b.kind)) return bad(res, 'Choose a type.');
    if (!Number.isFinite(value) || value < 0) return bad(res, 'Enter the value (or the quantity and price).');
    const on = isDate(b.as_of) ? b.as_of : ctx.localToday();
    try {
      const [r] = await P().query('INSERT INTO assets (name, kind, qty, unit, unit_price, value, note) VALUES (?,?,?,?,?,?,?)', [name, b.kind, qty, b.unit ? String(b.unit).slice(0, 12) : null, up, value, b.note ? String(b.note).slice(0, 255) : null]);
      await P().query('INSERT INTO asset_log (asset_id, on_date, value) VALUES (?,?,?)', [r.insertId, on, value]); res.status(201).json({ id: r.insertId });
    } catch (e) { fail(res, e); }
  });
  app.put('/api/assets/:id/value', async (req, res) => {          // new total value, or (for gold etc.) a new price per unit
    try {
      const [[a]] = await P().query('SELECT * FROM assets WHERE id=?', [req.params.id]); if (!a) return bad(res, 'Not found.');
      let value = num(req.body.value), up = a.unit_price;
      if (req.body.unit_price != null && req.body.unit_price !== '') { up = Number(req.body.unit_price); if (a.qty != null) value = Math.round(Number(a.qty) * up * 100) / 100; }
      if (!Number.isFinite(value) || value < 0) return bad(res, 'Enter a valid value.');
      const on = isDate(req.body.as_of) ? req.body.as_of : ctx.localToday();
      await P().query('UPDATE assets SET value=?, unit_price=? WHERE id=?', [value, up, a.id]);
      await P().query('DELETE FROM asset_log WHERE asset_id=? AND on_date=?', [a.id, on]);
      await P().query('INSERT INTO asset_log (asset_id, on_date, value) VALUES (?,?,?)', [a.id, on, value]); res.json({ ok: true, value });
    } catch (e) { fail(res, e); }
  });
  app.delete('/api/assets/:id', async (req, res) => { try { await P().query('DELETE FROM asset_log WHERE asset_id=?', [req.params.id]); await P().query('DELETE FROM assets WHERE id=?', [req.params.id]); res.json({ ok: true }); } catch (e) { fail(res, e); } });
  app.get('/api/assets/history', async (req, res) => {            // value at the end of each of the last 12 months
    try {
      const [items] = await P().query('SELECT id, kind FROM assets'), [log] = await P().query('SELECT asset_id, on_date, value FROM asset_log ORDER BY on_date, id');
      const t = ctx.localToday().slice(0, 7).split('-').map(Number), out = [];
      for (let i = 11; i >= 0; i--) {
        const d = new Date(t[0], t[1] - 1 - i, 1), ym = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; let assets = 0, debts = 0;
        for (const it of items) { let v = null; for (const l of log) if (l.asset_id === it.id && String(l.on_date) <= ym + '-31') v = Number(l.value); if (v != null) { if (it.kind === 'debt') debts += v; else assets += v; } }
        out.push({ ym, assets: Math.round(assets * 100) / 100, debts: Math.round(debts * 100) / 100 });
      }
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // ----- low-balance alerts -----
  app.get('/api/alerts/balance', async (req, res) => {
    try {
      const bal = (await ctx.balances()).filter(a => !a.archived && a.type !== 'card'), al = Object.fromEntries((await P().query('SELECT * FROM account_alerts'))[0].map(r => [r.account_id, Number(r.min_balance)]));
      res.json(bal.map(a => ({ id: a.id, name: a.name, type: a.type, balance: Number(a.balance), min_balance: al[a.id] ?? null })));
    } catch (e) { fail(res, e); }
  });
  app.put('/api/alerts/balance/:id', async (req, res) => {
    const v = num(req.body.min_balance);
    if (v !== null && !Number.isFinite(v)) return bad(res, 'Enter a number.');
    try {
      if (v === null) await P().query('DELETE FROM account_alerts WHERE account_id=?', [req.params.id]);
      else await P().query('INSERT INTO account_alerts (account_id, min_balance) VALUES (?,?) ON DUPLICATE KEY UPDATE min_balance=VALUES(min_balance)', [req.params.id, v]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.get('/api/reminders/more', async (req, res) => {            // below the minimum now, or after bills due in the next 7 days
    try {
      const al = (await P().query('SELECT * FROM account_alerts'))[0]; if (!al.length) return res.json([]);
      const bal = Object.fromEntries((await ctx.balances()).map(a => [a.id, a])), rec = (await P().query("SELECT * FROM recurring WHERE active=1 AND kind='expense' AND account_id IS NOT NULL"))[0];
      const t = new Date(ctx.localToday() + 'T00:00:00'), due = {};
      for (let d = 1; d <= 7; d++) {
        const day = new Date(t); day.setDate(t.getDate() + d);
        const ym = `${day.getFullYear()}-${pad(day.getMonth() + 1)}`, last = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
        rec.filter(r => ym >= r.start_month && Math.min(r.day_of_month, last) === day.getDate()).forEach(r => { due[r.account_id] = (due[r.account_id] || 0) + Number(r.amount); });
      }
      res.json(al.map(a => { const b = bal[a.account_id]; if (!b || b.archived) return null; const now = Number(b.balance), min = Number(a.min_balance), after = now - (due[a.account_id] || 0);
        return now < min ? { name: b.name, balance: now, min, kind: 'below' } : after < min ? { name: b.name, balance: now, min, after, bills: due[a.account_id], kind: 'bills' } : null; }).filter(Boolean));
    } catch (e) { fail(res, e); }
  });

  // ----- data health check + status page -----
  app.get('/api/health/data', async (req, res) => {
    try {
      const out = [], add = (key, level, text, action) => out.push({ key, level, text, action }), q = async (sql, p) => (await P().query(sql, p))[0];
      const today = ctx.localToday(), hasAcct = (await q('SELECT COUNT(*) AS n FROM accounts WHERE archived=0'))[0].n > 0;
      if (hasAcct) {
        const e = (await q('SELECT COUNT(*) AS n FROM expenses WHERE account_id IS NULL'))[0].n, i = (await q('SELECT COUNT(*) AS n FROM income WHERE account_id IS NULL'))[0].n, r = (await q("SELECT COUNT(*) AS n FROM recurring WHERE account_id IS NULL AND active=1"))[0].n;
        if (e) add('noacct_exp', 'info', `${e} expense${e > 1 ? 's have' : ' has'} no account, so balances ignore ${e > 1 ? 'them' : 'it'}. Tick them on the Expenses tab (search all months) and use "Account" in the bulk bar.`, { tab: 'expenses', label: 'Open expenses' });
        if (i) add('noacct_inc', 'info', `${i} income entr${i > 1 ? 'ies have' : 'y has'} no account.`, { tab: 'income', label: 'Open income' });
        if (r) add('noacct_rec', 'info', `${r} recurring item${r > 1 ? 's have' : ' has'} no account.`, { tab: 'recurring', label: 'Open recurring' });
        const stale = await q("SELECT name FROM accounts WHERE archived=0 AND type<>'cash' AND (reconciled_on IS NULL OR reconciled_on < DATE_SUB(?, INTERVAL 60 DAY))", [today]);
        if (stale.length) add('stale', 'warn', `Not checked against the real balance in 60+ days: ${stale.map(s => s.name).join(', ')}.`, { tab: 'accounts', label: 'Reconcile' });
        const bal = await ctx.balances();
        bal.filter(a => !a.archived && a.type === 'card' && a.credit_limit != null && Number(a.balance) < -Number(a.credit_limit)).forEach(a => add('limit_' + a.id, 'warn', `${a.name} is over its credit limit.`, { tab: 'accounts', label: 'Open accounts' }));
        bal.filter(a => !a.archived && a.type !== 'card' && Number(a.balance) < 0).forEach(a => add('neg_' + a.id, 'warn', `${a.name} shows a negative balance. A missing deposit or a wrong starting balance?`, { tab: 'accounts', label: 'Reconcile' }));
      }
      const g = await q('SELECT name FROM goals g WHERE NOT EXISTS (SELECT 1 FROM goal_log l WHERE l.goal_id = g.id)');
      if (g.length) add('goals', 'info', `No deposits yet for: ${g.map(x => x.name).join(', ')}.`, { tab: 'goals', label: 'Open goals' });
      const d = await q('SELECT 1 FROM expenses GROUP BY spent_on, LOWER(title), amount HAVING COUNT(*) > 1 LIMIT 50');
      if (d.length) add('dups', 'warn', `${d.length} group${d.length > 1 ? 's' : ''} of possible duplicate expenses.`, { tab: 'backup', label: 'Find duplicates' });
      const o = (await q("SELECT COUNT(*) AS n FROM expenses WHERE category='Other'"))[0].n, rules = (await q('SELECT COUNT(*) AS n FROM rules'))[0].n;
      if (o) add('other', 'info', `${o} expense${o > 1 ? 's are' : ' is'} in "Other".${rules ? ' Your rules may be able to sort them.' : ' A rule can sort repeat items automatically.'}`, rules ? { rules: true, label: 'Apply my rules' } : { tab: 'categories', label: 'Add a rule' });
      const files = ctx.paths.BACKUP_DIR && fs.existsSync(ctx.paths.BACKUP_DIR) ? fs.readdirSync(ctx.paths.BACKUP_DIR).map(f => fs.statSync(path.join(ctx.paths.BACKUP_DIR, f)).mtimeMs) : [];
      const age = files.length ? (Date.now() - Math.max(...files)) / 864e5 : null;
      if (age === null || age > 7) add('backup', 'warn', age === null ? 'No backup file exists yet.' : `Your newest backup is ${Math.floor(age)} days old.`, { tab: 'backup', label: 'Open backups' });
      const att = await q('SELECT stored_name FROM attachments WHERE expense_id > 0 LIMIT 2000'), miss = att.filter(a => !fs.existsSync(path.join(ctx.paths.RECEIPT_DIR, a.stored_name))).length;
      if (miss) add('receipts', 'warn', `${miss} receipt file${miss > 1 ? 's are' : ' is'} missing from the receipts folder.`, null);
      res.json(out);
    } catch (e) { fail(res, e); }
  });
  app.get('/api/status', async (req, res) => {
    try {
      const P2 = P(), [[v]] = await P2.query('SELECT VERSION() AS v');
      const cnt = {}; for (const t of ['expenses', 'income', 'accounts', 'transfers', 'goals', 'attachments']) cnt[t] = (await P2.query(`SELECT COUNT(*) AS n FROM ${t}`))[0][0].n;
      const dir = ctx.paths.BACKUP_DIR, files = fs.existsSync(dir) ? fs.readdirSync(dir).map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t) : [];
      let version = '?'; try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch {}
      res.json({ database: { connected: true, version: v.v }, app: { version, node: process.version, uptime_minutes: Math.round(process.uptime() / 60) }, counts: cnt,
        last_backup: files[0] ? { file: files[0].f, hours_ago: Math.round((Date.now() - files[0].t) / 36e5) } : null,
        sizes_mb: { backups: Math.round(folderSize(dir) / 1048576 * 10) / 10, receipts: Math.round(folderSize(ctx.paths.RECEIPT_DIR) / 1048576 * 10) / 10 }, flags: ctx.flags() });
    } catch (e) { res.status(500).json({ error: e.message, database: { connected: false } }); }
  });

  // ----- quick PIN (under /api/auth/, so it works from the lock screen) -----
  app.get('/api/auth/pin/status', (req, res) => res.json({ set: !!pinHash, available: pinAvailable() }));
  app.post('/api/auth/pin', (req, res) => {
    if (!pinAvailable()) return res.status(403).json({ error: 'Use your password to sign in.' });
    if (typeof req.body.pin !== 'string' || !checkPin(req.body.pin, pinHash)) { pinFails++; return res.status(403).json({ error: pinFails >= 5 ? 'Too many wrong PINs. Use your password.' : 'Wrong PIN.' }); }
    pinFails = 0; ctx.startSession(res); res.json({ ok: true });
  });
  app.post('/api/auth/pin/set', async (req, res) => {
    if (!ctx.hasPassword()) return bad(res, 'Set a password first (Security tab); the PIN is a shortcut for it.');
    if (!ctx.isAuthed(req)) return res.status(401).json({ error: 'locked' });
    const err = ctx.verifyPassword(req.body.current); if (err) return res.status(err.code).json({ error: err.error === 'Wrong password.' ? 'Current password is wrong.' : err.error });
    if (!/^\d{4,8}$/.test(String(req.body.pin || ''))) return bad(res, 'The PIN must be 4 to 8 digits.');
    try { pinHash = hashPin(String(req.body.pin)); await P().query("INSERT INTO settings (k, v) VALUES ('pin_hash', ?) ON DUPLICATE KEY UPDATE v=VALUES(v)", [pinHash]); noteFullLogin(); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post('/api/auth/pin/remove', async (req, res) => {
    if (ctx.hasPassword()) {
      if (!ctx.isAuthed(req)) return res.status(401).json({ error: 'locked' });
      const err = ctx.verifyPassword(req.body.current); if (err) return res.status(err.code).json({ error: err.error === 'Wrong password.' ? 'Current password is wrong.' : err.error });
    }
    try { await P().query("DELETE FROM settings WHERE k='pin_hash'"); pinHash = null; res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
}
module.exports = { register, migrate, extraBackup, extraRestore, noteFullLogin };
