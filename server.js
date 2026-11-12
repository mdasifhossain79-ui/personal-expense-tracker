const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const extras = require('./extras');
const extras2 = require('./extras2');
const os = require('os');

// ---- Database config: use environment variables or a local db-config.json file only. ----
const DB = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
  name: process.env.DB_NAME || 'expense_tracker',
};
const PORT = Number(process.env.PORT || 3005);

try {
  const localConfigPath = path.join(__dirname, 'db-config.json');
  const localConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
  if (localConfig && typeof localConfig === 'object') Object.assign(DB, localConfig);
} catch (err) {
  // Ignore missing local config; the app expects env-based configuration in production.
}

if (!DB.password) {
  console.error('Missing database password. Set DB_PASSWORD or MYSQL_PASSWORD in the environment before starting the app.');
  process.exit(1);
}
// -----------------------------------------------------

const normTags = v => [...new Set(String(v || '').split(',').map(t => t.trim().toLowerCase().replace(/[<>"'&]/g, '').slice(0, 30)).filter(Boolean))].slice(0, 8).join(',') || null;
const EXP_SEL = 'SELECT e.*, (SELECT COUNT(*) FROM attachments a WHERE a.expense_id = e.id) AS receipts FROM expenses e';
// Phone / other devices on your home network: opt-in ("lan": true in db-config.json, or LAN_ACCESS=1).
const LAN = process.env.LAN_ACCESS === '1' || DB.lan === true;
const isLocalIp = ip => ['127.0.0.1', '::1'].includes(String(ip).replace('::ffff:', ''));
const isPrivateIp = ip => { ip = String(ip).replace('::ffff:', ''); return isLocalIp(ip) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip); };
const accId = v => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const ACCT_TYPES = ['bank', 'card', 'mfs', 'cash'];
const app = express();
async function canonCategory(name) {
  name = String(name).trim().slice(0, 50);
  const [r] = await pool.query('SELECT name FROM categories WHERE name=?', [name]);
  if (r.length) return r[0].name;
  await pool.query('INSERT INTO categories (name) VALUES (?)', [name]);
  return name;
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'");
  // block cross-site writes
  const o = req.headers.origin;
  if (o && req.method !== 'GET' && req.method !== 'HEAD') {
    try { if (new URL(o).host !== req.headers.host) return res.status(403).send('Forbidden'); } catch { return res.status(403).send('Forbidden'); }
  }
  next();
});

// Only answer requests addressed to this PC (blocks DNS-rebinding tricks).
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (LAN) {
    const ip = req.socket.remoteAddress || '';
    if (!isPrivateIp(ip)) return res.status(403).send('Forbidden');
    if (!isLocalIp(ip) && !passHash) return res.status(403).send('Set a password on the PC first (Security tab), then reload this page.');
  } else if (host !== 'localhost' && host !== '127.0.0.1') return res.status(403).send('Forbidden');
  next();
});
app.use(express.json({ limit: '25mb' }));

// Password gate: when a password is set, every /api call except /api/auth/* needs a session.
app.use('/api', (req, res, next) => {
  if (!passHash || req.path.startsWith('/auth/') || isAuthed(req)) return next();
  res.status(401).json({ error: 'locked' });
});
app.use(express.static(path.join(__dirname, 'public')));

let pool;
let passHash = null;
let backupKey = null, backupSalt = null;   // set when encrypted daily backups are on

async function init() {
  const conn = await mysql.createConnection({
    host: DB.host, port: DB.port, user: DB.user, password: DB.password,
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB.name}\``);
  await conn.end();

  pool = mysql.createPool({
    host: DB.host, port: DB.port, user: DB.user, password: DB.password,
    database: DB.name, dateStrings: true, connectionLimit: 5,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      spent_on DATE NOT NULL,
      title VARCHAR(150) NOT NULL,
      category VARCHAR(50) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      note VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_spent_on (spent_on)
    )`);
  const [hasTags] = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=? AND table_name='expenses' AND column_name='tags'", [DB.name]);
  if (!hasTags.length) await pool.query('ALTER TABLE expenses ADD COLUMN tags VARCHAR(255) NULL');
  await pool.query(`CREATE TABLE IF NOT EXISTS goals (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, target DECIMAL(12,2) NOT NULL, deadline DATE NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS goal_log (
      id INT AUTO_INCREMENT PRIMARY KEY, goal_id INT NOT NULL, amount DECIMAL(12,2) NOT NULL, logged_on DATE NOT NULL, INDEX (goal_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS attachments (
      id INT AUTO_INCREMENT PRIMARY KEY, expense_id INT NOT NULL, filename VARCHAR(150) NOT NULL,
      stored_name VARCHAR(80) NOT NULL, mime VARCHAR(50) NOT NULL, size INT NOT NULL, INDEX (expense_id))`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      name VARCHAR(50) PRIMARY KEY,
      monthly_budget DECIMAL(12,2) NULL
    )`);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM categories');
  if (n === 0) {
    const defaults = ['Food','Transport','Housing','Utilities','Health','Shopping','Entertainment','Education','Other'];
    await pool.query('INSERT INTO categories (name) VALUES ?', [defaults.map(d => [d])]);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recurring (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(150) NOT NULL,
      category VARCHAR(50) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      note VARCHAR(255) NULL,
      day_of_month TINYINT NOT NULL,
      start_month CHAR(7) NOT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recurring_log (
      recurring_id INT NOT NULL,
      ym CHAR(7) NOT NULL,
      PRIMARY KEY (recurring_id, ym)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS income (
      id INT AUTO_INCREMENT PRIMARY KEY,
      received_on DATE NOT NULL,
      source VARCHAR(100) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      note VARCHAR(255) NULL,
      INDEX idx_received_on (received_on)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      k VARCHAR(50) PRIMARY KEY,
      v TEXT NOT NULL
    )`);
  const [pw] = await pool.query("SELECT v FROM settings WHERE k='password'");
  passHash = pw.length ? pw[0].v : null;
  const [bk] = await pool.query("SELECT k, v FROM settings WHERE k IN ('backup_key','backup_salt')");
  const bkm = Object.fromEntries(bk.map(r => [r.k, r.v]));
  if (bkm.backup_key && bkm.backup_salt) { backupKey = Buffer.from(bkm.backup_key, 'hex'); backupSalt = Buffer.from(bkm.backup_salt, 'hex'); }
  const [hasKind] = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=? AND table_name='recurring' AND column_name='kind'", [DB.name]);
  if (!hasKind.length) await pool.query("ALTER TABLE recurring ADD COLUMN kind VARCHAR(10) NOT NULL DEFAULT 'expense'");
  for (const [t, c] of [['expenses', 'account_id'], ['income', 'account_id']]) {
    const [has] = await pool.query('SELECT 1 FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?', [DB.name, t, c]);
    if (!has.length) await pool.query(`ALTER TABLE ${t} ADD COLUMN ${c} INT NULL`);
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
      id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(60) NOT NULL, type VARCHAR(10) NOT NULL,
      opening_balance DECIMAL(12,2) NOT NULL DEFAULT 0, credit_limit DECIMAL(12,2) NULL, due_day TINYINT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS transfers (
      id INT AUTO_INCREMENT PRIMARY KEY, moved_on DATE NOT NULL, from_id INT NOT NULL, to_id INT NOT NULL,
      amount DECIMAL(12,2) NOT NULL, fee DECIMAL(12,2) NOT NULL DEFAULT 0, note VARCHAR(255) NULL, INDEX (moved_on))`);
  for (const [t, c, def] of [['accounts', 'provider', 'VARCHAR(60) NULL'], ['accounts', 'acct_no', 'VARCHAR(30) NULL'],
      ['accounts', 'archived', 'TINYINT(1) NOT NULL DEFAULT 0'], ['accounts', 'reconciled_on', 'DATE NULL'], ['accounts', 'monthly_limit', 'DECIMAL(12,2) NULL'],
      ['transfers', 'fee_expense_id', 'INT NULL'], ['recurring', 'account_id', 'INT NULL']]) {
    const [has] = await pool.query('SELECT 1 FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?', [DB.name, t, c]);
    if (!has.length) await pool.query(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
  }
  await fixFeeExpenses(pool);
  await extras.migrate(pool, DB);
  await extras2.migrate(pool);
  // keep categories used by older expenses
  await pool.query('INSERT IGNORE INTO categories (name) SELECT DISTINCT category FROM expenses');
}

function validate(b) {
  const amount = Number(b.amount);
  if (!b.title || !String(b.title).trim()) return 'Enter a title.';
  if (!b.category || !String(b.category).trim()) return 'Choose a category.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.spent_on || '')) return 'Enter a valid date.';
  if (!Number.isFinite(amount) || amount <= 0) return 'Amount must be greater than 0.';
  return null;
}

function monthRange(month) { return extras.monthRange(month); }   // honours the "budget month starts on day N" setting

app.get('/api/expenses', async (req, res) => {
  try {
    const r = monthRange(req.query.month);
    const [rows] = r
      ? await pool.query(EXP_SEL + ' WHERE e.spent_on >= ? AND e.spent_on < ? ORDER BY e.spent_on DESC, e.id DESC', r)
      : await pool.query(EXP_SEL + ' ORDER BY e.spent_on DESC, e.id DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/expenses', async (req, res) => {
  const err = validate(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { spent_on, title, category, amount, note, tags, account_id } = req.body;
    const [r] = await pool.query(
      'INSERT INTO expenses (spent_on, title, category, amount, note, tags, account_id) VALUES (?,?,?,?,?,?,?)',
      [spent_on, title.trim(), await canonCategory(category), Number(amount), note || null, normTags(tags), accId(account_id)]);
    const old = Number(req.body.restore_from);   // Undo: bring back the receipts of the deleted expense
    if (old > 0 && trash.has(old)) { await pool.query('UPDATE attachments SET expense_id=? WHERE expense_id=?', [r.insertId, -old]); trash.delete(old); }
    res.status(201).json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/expenses/:id', async (req, res) => {
  const err = validate(req.body);
  if (err) return res.status(400).json({ error: err });
  try {
    const { spent_on, title, category, amount, note, tags, account_id } = req.body;
    await pool.query(
      'UPDATE expenses SET spent_on=?, title=?, category=?, amount=?, note=?, tags=?, account_id=? WHERE id=?',
      [spent_on, title.trim(), await canonCategory(category), Number(amount), note || null, normTags(tags), accId(account_id), req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    await pool.query('UPDATE attachments SET expense_id = -expense_id WHERE expense_id=?', [req.params.id]);   // trash, not delete
    trash.set(Number(req.params.id), Date.now());
    await pool.query('DELETE FROM expenses WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/categories', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT name, monthly_budget, rollover FROM categories ORDER BY name');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/categories', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 50);
  const budget = req.body.monthly_budget === '' || req.body.monthly_budget == null ? null : Number(req.body.monthly_budget);
  if (!name) return res.status(400).json({ error: 'Enter a category name.' });
  if (budget !== null && (!Number.isFinite(budget) || budget < 0)) return res.status(400).json({ error: 'Budget must be 0 or more.' });
  try {
    const [r] = await pool.query('INSERT IGNORE INTO categories (name, monthly_budget) VALUES (?,?)', [name, budget]);
    if (!r.affectedRows) return res.status(400).json({ error: 'That category already exists.' });
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/categories/:name', async (req, res) => {
  const budget = req.body.monthly_budget === '' || req.body.monthly_budget == null ? null : Number(req.body.monthly_budget);
  if (budget !== null && (!Number.isFinite(budget) || budget < 0)) return res.status(400).json({ error: 'Budget must be 0 or more.' });
  try {
    await pool.query('UPDATE categories SET monthly_budget=? WHERE name=?', [budget, req.params.name]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/categories/:name/rename', async (req, res) => {
  const from = req.params.name, to = String(req.body.to || '').trim().slice(0, 50);
  if (!to) return res.status(400).json({ error: 'Enter the new name.' });
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [src] = await conn.query('SELECT * FROM categories WHERE name=?', [from]);
    if (!src.length) { await conn.rollback(); return res.status(404).json({ error: 'Category not found.' }); }
    const [tgt] = await conn.query('SELECT * FROM categories WHERE name=?', [to]);   // case-insensitive match
    let finalName = to, merged = false;
    if (tgt.length && tgt[0].name.toLowerCase() !== from.toLowerCase()) {
      finalName = tgt[0].name; merged = true;
      if (tgt[0].monthly_budget == null && src[0].monthly_budget != null)
        await conn.query('UPDATE categories SET monthly_budget=? WHERE name=?', [src[0].monthly_budget, finalName]);
      await conn.query('DELETE FROM categories WHERE name=?', [from]);
    } else await conn.query('UPDATE categories SET name=? WHERE name=?', [to, from]);
    const [r] = await conn.query('UPDATE expenses SET category=? WHERE category=?', [finalName, from]);
    await conn.query('UPDATE recurring SET category=? WHERE category=?', [finalName, from]);
    await conn.commit();
    res.json({ name: finalName, merged, expenses: r.affectedRows });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { if (conn) conn.release(); }
});

app.delete('/api/categories/:name', async (req, res) => {
  try {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM expenses WHERE category=?', [req.params.name]);
    if (n > 0) return res.status(400).json({ error: `${n} expense(s) use this category. Reassign or delete them first.` });
    await pool.query('DELETE FROM categories WHERE name=?', [req.params.name]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/report', async (req, res) => {
  const year = Number(req.query.year);
  if (!Number.isInteger(year)) return res.status(400).json({ error: 'Invalid year.' });
  try {
    const [rows] = await pool.query(
      `SELECT MONTH(spent_on) AS m, category, SUM(amount) AS total
       FROM expenses WHERE YEAR(spent_on)=? GROUP BY m, category`, [year]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- recurring expenses ----------
const pad = n => String(n).padStart(2, '0');
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Creates any due, not-yet-created expenses. Safe to call repeatedly.
async function runRecurring() {
  const [items] = await pool.query('SELECT * FROM recurring WHERE active=1');
  const todayStr = localToday();
  const curYm = todayStr.slice(0, 7);
  let created = 0;
  for (const it of items) {
    let [y, m] = it.start_month.split('-').map(Number);
    while (`${y}-${pad(m)}` <= curYm) {
      const ym = `${y}-${pad(m)}`;
      const last = new Date(y, m, 0).getDate();
      const date = `${ym}-${pad(Math.min(it.day_of_month, last))}`;
      if (date <= todayStr) {
        const [r] = await pool.query('INSERT IGNORE INTO recurring_log (recurring_id, ym) VALUES (?,?)', [it.id, ym]);
        if (r.affectedRows) {
          if (it.kind === 'income') await pool.query('INSERT INTO income (received_on, source, amount, note, account_id) VALUES (?,?,?,?,?)', [date, it.title, it.amount, it.note, it.account_id]);
          else await pool.query('INSERT INTO expenses (spent_on, title, category, amount, note, account_id) VALUES (?,?,?,?,?,?)', [date, it.title, it.category, it.amount, it.note, it.account_id]);
          created++;
        }
      }
      m++; if (m > 12) { m = 1; y++; }
    }
  }
  return created;
}

app.get('/api/recurring', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM recurring ORDER BY active DESC, title');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/recurring', async (req, res) => {
  const b = req.body, amount = Number(b.amount), day = Number(b.day_of_month);
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'Enter a title.' });
  const kind = b.kind === 'income' ? 'income' : 'expense';
  if (kind === 'expense' && !b.category) return res.status(400).json({ error: 'Choose a category.' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be greater than 0.' });
  if (!Number.isInteger(day) || day < 1 || day > 31) return res.status(400).json({ error: 'Day must be between 1 and 31.' });
  if (!/^\d{4}-\d{2}$/.test(b.start_month || '')) return res.status(400).json({ error: 'Choose a start month.' });
  try {
    await pool.query(
      'INSERT INTO recurring (title, category, amount, note, day_of_month, start_month, kind, account_id) VALUES (?,?,?,?,?,?,?,?)',
      [b.title.trim(), kind === 'income' ? 'Income' : await canonCategory(b.category), amount, b.note || null, day, b.start_month, kind, accId(b.account_id)]);
    const created = await runRecurring();
    res.status(201).json({ created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/recurring/:id/active', async (req, res) => {
  try {
    if (req.body.active) {
      // resuming never back-fills months that were missed while paused
      await pool.query('UPDATE recurring SET active=1, start_month=GREATEST(start_month, ?) WHERE id=?',
        [localToday().slice(0, 7), req.params.id]);
    } else {
      await pool.query('UPDATE recurring SET active=0 WHERE id=?', [req.params.id]);
    }
    const created = await runRecurring();
    res.json({ created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/recurring/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM recurring_log WHERE recurring_id=?', [req.params.id]);
    await pool.query('DELETE FROM recurring WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/recurring/upcoming', async (req, res) => {
  try {
    const [items] = await pool.query('SELECT * FROM recurring WHERE active=1');
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const out = [];
    for (const it of items) for (const off of [0, 1]) {
      const first = new Date(t.getFullYear(), t.getMonth() + off, 1);
      const ym = `${first.getFullYear()}-${pad(first.getMonth() + 1)}`;
      if (ym < it.start_month) continue;
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      const d = new Date(first.getFullYear(), first.getMonth(), Math.min(it.day_of_month, last));
      const days = Math.round((d - t) / 864e5);
      if (days >= 1 && days <= 3) out.push({ title: it.title, amount: it.amount, kind: it.kind, days, date: `${ym}-${pad(d.getDate())}` });
    }
    res.json(out.sort((a, b) => a.days - b.days));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/recurring/run', async (req, res) => {
  try { res.json({ created: await runRecurring() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- backup & restore ----------
const BACKUP_DIR = path.join(__dirname, 'backups');

async function buildBackup() {
  const [categories] = await pool.query('SELECT name, monthly_budget, rollover FROM categories ORDER BY name');
  const [expenses] = await pool.query('SELECT id, spent_on, title, category, amount, note, tags, account_id FROM expenses ORDER BY id');
  const [recurring] = await pool.query('SELECT * FROM recurring ORDER BY id');
  const [recurring_log] = await pool.query('SELECT recurring_id, ym FROM recurring_log');
  const [income] = await pool.query('SELECT id, received_on, source, amount, note, account_id FROM income ORDER BY id');
  const [accounts] = await pool.query('SELECT * FROM accounts ORDER BY id');
  const [transfers] = await pool.query('SELECT * FROM transfers ORDER BY id');
  const [goals] = await pool.query('SELECT * FROM goals ORDER BY id');
  const [goal_log] = await pool.query('SELECT * FROM goal_log ORDER BY id');
  const [attachments] = await pool.query('SELECT * FROM attachments ORDER BY id');
  return { app: 'ledger-expense-tracker', version: 1, ...(await extras.extraBackup()), ...(await extras2.extraBackup()), accounts, transfers, goals, goal_log, attachments, created: new Date().toISOString(),
           categories, expenses, recurring, recurring_log, income };
}

function encryptWithKey(obj) {
  const iv = crypto.randomBytes(12), b64 = x => x.toString('base64');
  const c = crypto.createCipheriv('aes-256-gcm', backupKey, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { enc: 'ledger-aes256gcm', v: 1, salt: b64(backupSalt), iv: b64(iv), tag: b64(c.getAuthTag()), data: b64(data) };
}
function saveBackupFile(name, data) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (backupKey) { name = name.replace(/\.json$/, '.enc.json'); data = encryptWithKey(data); }
  fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(data));
}

// One automatic backup file per day, newest 14 kept.
async function autoBackup() {
  const name = `auto-${localToday()}.json`;
  const onDisk = backupKey ? name.replace(/\.json$/, '.enc.json') : name;
  if (!fs.existsSync(path.join(BACKUP_DIR, onDisk))) saveBackupFile(name, await buildBackup());
  const old = fs.readdirSync(BACKUP_DIR).filter(f => /^auto-.*\.json$/.test(f)).sort().slice(0, -14);
  old.forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
}

app.get('/api/backup', async (req, res) => {
  try {
    const data = await buildBackup();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="expense-tracker-backup-${localToday()}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup/auto', (req, res) => res.json({ enabled: !!backupKey }));
app.post('/api/backup/auto', async (req, res) => {
  try {
    if (req.body.enabled === false) {
      await pool.query("DELETE FROM settings WHERE k IN ('backup_key','backup_salt')");
      backupKey = backupSalt = null;
      return res.json({ enabled: false });
    }
    const pass = req.body.passphrase;
    if (typeof pass !== 'string' || pass.length < 8) return res.status(400).json({ error: 'Passphrase must be at least 8 characters.' });
    const salt = crypto.randomBytes(16), key = crypto.scryptSync(pass, salt, 32);
    await pool.query("INSERT INTO settings (k, v) VALUES ('backup_key', ?), ('backup_salt', ?) ON DUPLICATE KEY UPDATE v=VALUES(v)", [key.toString('hex'), salt.toString('hex')]);
    backupKey = key; backupSalt = salt;
    let converted = 0;   // encrypt the plain copies that already exist, then remove them
    if (fs.existsSync(BACKUP_DIR)) for (const f of fs.readdirSync(BACKUP_DIR)) {
      if (!/^(auto|pre-restore)-/.test(f) || !f.endsWith('.json') || f.endsWith('.enc.json')) continue;
      const p = path.join(BACKUP_DIR, f);
      try {
        fs.writeFileSync(path.join(BACKUP_DIR, f.replace(/\.json$/, '.enc.json')), JSON.stringify(encryptWithKey(JSON.parse(fs.readFileSync(p, 'utf8')))));
        fs.unlinkSync(p); converted++;
      } catch {}
    }
    await autoBackup();
    res.json({ enabled: true, converted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function encryptBackup(obj, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(pass, salt, 32), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const b64 = x => x.toString('base64');
  return { enc: 'ledger-aes256gcm', v: 1, salt: b64(salt), iv: b64(iv), tag: b64(c.getAuthTag()), data: b64(data) };
}
function decryptBackup(f, pass) {
  const u = x => Buffer.from(x, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(String(pass), u(f.salt), 32), u(f.iv));
  d.setAuthTag(u(f.tag));
  return JSON.parse(Buffer.concat([d.update(u(f.data)), d.final()]).toString('utf8'));
}
app.post('/api/backup/encrypted', async (req, res) => {
  const pass = req.body.passphrase;
  if (typeof pass !== 'string' || pass.length < 8) return res.status(400).json({ error: 'Passphrase must be at least 8 characters.' });
  try { res.json(encryptBackup(await buildBackup(), pass)); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/restore', async (req, res) => {
  let b = req.body || {};
  if (b.ledger_encrypted) {
    try { b = decryptBackup(b.file, b.passphrase); } catch { return res.status(400).json({ error: 'Wrong passphrase, or the file is damaged.' }); }
  }
  if (b.app !== 'ledger-expense-tracker' || !Array.isArray(b.expenses) || !Array.isArray(b.categories)) {
    return res.status(400).json({ error: 'This is not a Personal Expense Tracker backup file.' });
  }
  const recurring = Array.isArray(b.recurring) ? b.recurring : [];
  const log = Array.isArray(b.recurring_log) ? b.recurring_log : [];
  for (const [i, e] of b.expenses.entries()) {
    const err = validate(e);
    if (err || !Number.isInteger(Number(e.id))) return res.status(400).json({ error: `Expense #${i + 1} is invalid${err ? ': ' + err : '.'}` });
  }
  const catNames = new Set(b.categories.map(c => String(c.name || '').trim()).filter(Boolean));
  b.expenses.forEach(e => catNames.add(String(e.category).trim()));
  recurring.forEach(r => r.category && catNames.add(String(r.category).trim()));

  let conn;
  try {
    if (!req.body.dry) saveBackupFile(`pre-restore-${Date.now()}.json`, await buildBackup()); // safety copy of current data
    conn = await pool.getConnection();
    await conn.beginTransaction();
    for (const t of ['attachments', 'goal_log', 'goals', 'transfers', 'accounts', 'income', 'recurring_log', 'recurring', 'expenses', 'categories']) await conn.query(`DELETE FROM ${t}`);

    const budgets = Object.fromEntries(b.categories.map(c => [String(c.name || '').trim(), c.monthly_budget == null ? null : Number(c.monthly_budget)]));
    const roll = Object.fromEntries(b.categories.map(c => [String(c.name || '').trim(), c.rollover ? 1 : 0]));
    const cats = [...catNames].map(n => [n.slice(0, 50), Number.isFinite(budgets[n]) ? budgets[n] : null, roll[n] || 0]);
    if (cats.length) await conn.query('INSERT INTO categories (name, monthly_budget, rollover) VALUES ?', [cats]);

    for (let i = 0; i < b.expenses.length; i += 500) {
      const chunk = b.expenses.slice(i, i + 500).map(e =>
        [Number(e.id), e.spent_on, String(e.title).trim(), String(e.category).trim(), Number(e.amount), e.note || null, normTags(e.tags), accId(e.account_id)]);
      await conn.query('INSERT INTO expenses (id, spent_on, title, category, amount, note, tags, account_id) VALUES ?', [chunk]);
    }
    const accs = (Array.isArray(b.accounts) ? b.accounts : []).filter(a => ACCT_TYPES.includes(a.type) && a.name);
    if (accs.length) await conn.query('INSERT INTO accounts (id, name, type, opening_balance, credit_limit, due_day, provider, acct_no, archived, reconciled_on, monthly_limit) VALUES ?',
      [accs.map(a => [Number(a.id), String(a.name).slice(0, 60), a.type, Number(a.opening_balance) || 0, a.credit_limit == null ? null : Number(a.credit_limit), a.due_day == null ? null : Number(a.due_day), a.provider || null, a.acct_no || null, a.archived ? 1 : 0, a.reconciled_on || null, a.monthly_limit == null ? null : Number(a.monthly_limit)])]);
    const trs = (Array.isArray(b.transfers) ? b.transfers : []).filter(t => accs.some(a => Number(a.id) === Number(t.from_id)) && accs.some(a => Number(a.id) === Number(t.to_id)));
    if (trs.length) await conn.query('INSERT INTO transfers (id, moved_on, from_id, to_id, amount, fee, note, fee_expense_id) VALUES ?',
      [trs.map(t => [Number(t.id), t.moved_on, Number(t.from_id), Number(t.to_id), Number(t.amount), Number(t.fee) || 0, t.note || null, b.expenses.some(e => Number(e.id) === Number(t.fee_expense_id)) ? Number(t.fee_expense_id) : null])]);
    const goals = Array.isArray(b.goals) ? b.goals : [], glog = Array.isArray(b.goal_log) ? b.goal_log : [];
    if (goals.length) await conn.query('INSERT INTO goals (id, name, target, deadline, monthly_amount, start_month) VALUES ?', [goals.map(g => [Number(g.id), String(g.name).slice(0, 100), Number(g.target), g.deadline || null, g.monthly_amount == null ? null : Number(g.monthly_amount), g.start_month || null])]);
    const okLog = glog.filter(l => goals.some(g => Number(g.id) === Number(l.goal_id)));
    if (okLog.length) await conn.query('INSERT INTO goal_log (goal_id, amount, logged_on, auto_ym) VALUES ?', [okLog.map(l => [Number(l.goal_id), Number(l.amount), l.logged_on, l.auto_ym || null])]);
    const ids = new Set(b.expenses.map(e => Number(e.id)));
    const att = (Array.isArray(b.attachments) ? b.attachments : []).filter(a => ids.has(Number(a.expense_id)) && /^[\w.-]+$/.test(a.stored_name || ''));
    if (att.length) await conn.query('INSERT INTO attachments (id, expense_id, filename, stored_name, mime, size) VALUES ?', [att.map(a => [Number(a.id), Number(a.expense_id), String(a.filename).slice(0, 150), a.stored_name, a.mime, Number(a.size)])]);
    const inc = (Array.isArray(b.income) ? b.income : []).filter(i => !vInc(i));
    if (inc.length) await conn.query('INSERT INTO income (id, received_on, source, amount, note, account_id) VALUES ?',
      [inc.map(i => [Number(i.id), i.received_on, String(i.source).trim(), Number(i.amount), i.note || null, accId(i.account_id)])]);
    if (recurring.length) {
      await conn.query('INSERT INTO recurring (id, title, category, amount, note, day_of_month, start_month, active, kind, account_id) VALUES ?',
        [recurring.map(r => [Number(r.id), r.title, r.category, Number(r.amount), r.note || null,
                             Number(r.day_of_month), r.start_month, r.active ? 1 : 0, r.kind === 'income' ? 'income' : 'expense', accId(r.account_id)])]);
    }
    const goodLog = log.filter(l => recurring.some(r => Number(r.id) === Number(l.recurring_id)));
    if (goodLog.length) await conn.query('INSERT INTO recurring_log (recurring_id, ym) VALUES ?', [goodLog.map(l => [Number(l.recurring_id), l.ym])]);

    await extras.extraRestore(conn, b);
    await extras2.extraRestore(conn, b);
    if (req.body.dry) {   // "Test my backup": everything above really ran, now undo it
      await conn.rollback();
      return res.json({ dry: true, ok: true, expenses: b.expenses.length, income: (b.income || []).length, accounts: accs.length, transfers: trs.length, goals: goals.length, categories: cats.length, recurring: recurring.length, attachments: att.length, created: b.created || null });
    }
    await conn.commit();
    await fixFeeExpenses(pool);
    res.json({ expenses: b.expenses.length, categories: cats.length, recurring: recurring.length });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    res.status(500).json({ error: 'Restore failed, nothing was changed: ' + e.message });
  } finally { if (conn) conn.release(); }
});

// ---------- security log ----------
const LOG_FILE = path.join(__dirname, 'security.log');
const secLog = msg => { try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()}  ${msg}\n`); } catch {} };
app.get('/api/security/log', (req, res) => {
  try { res.json(fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-15).reverse() : []); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- password lock ----------
const sessions = new Map();           // token -> expiry (ms)
const SESSION_MS = 30 * 60 * 1000;   // idle timeout (sliding)
let failCount = 0, lockedUntil = 0;

const hashPw = pw => {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
};
const checkPw = (pw, stored) => {
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(calc, Buffer.from(hash, 'hex'));
};
const getToken = req => {
  const m = /(?:^|;\s*)ledger_session=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return m && m[1];
};
function isAuthed(req) {
  const t = getToken(req), exp = t && sessions.get(t);
  if (!exp || exp < Date.now()) { if (t) sessions.delete(t); return false; }
  sessions.set(t, Date.now() + SESSION_MS);   // sliding expiry
  return true;
}
function startSession(res) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `ledger_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}
// returns an error object, or null if the password is right
function verifyPassword(pw) {
  const wait = Math.ceil((lockedUntil - Date.now()) / 1000);
  if (wait > 0) return { code: 429, error: `Too many attempts. Try again in ${wait} seconds.` };
  if (typeof pw === 'string' && passHash && checkPw(pw, passHash)) { failCount = 0; return null; }
  if (++failCount >= 5) { lockedUntil = Date.now() + 60000; failCount = 0; }
  return { code: 403, error: 'Wrong password.' };
}

app.get('/api/auth/status', (req, res) => {
  res.json({ enabled: !!passHash, authed: !passHash || isAuthed(req) });
});

app.post('/api/auth/login', (req, res) => {
  if (!passHash) return res.json({ ok: true });
  const bad = verifyPassword(req.body.password);
  if (bad) { secLog(bad.code === 429 ? 'Sign-in blocked (too many attempts)' : 'Failed sign-in attempt'); return res.status(bad.code).json({ error: bad.error }); }
  startSession(res);
  extras2.noteFullLogin();
  secLog('Sign-in OK');
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  sessions.delete(getToken(req));
  res.setHeader('Set-Cookie', 'ledger_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.post('/api/auth/set', async (req, res) => {
  if (passHash && !isAuthed(req)) return res.status(401).json({ error: 'locked' });
  const pw = req.body.password;
  if (typeof pw !== 'string' || pw.length < 6 || pw.length > 200)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (passHash) {
    const bad = verifyPassword(req.body.current);
    if (bad) return res.status(bad.code).json({ error: bad.error === 'Wrong password.' ? 'Current password is wrong.' : bad.error });
  }
  try {
    const h = hashPw(pw);
    await pool.query("INSERT INTO settings (k, v) VALUES ('password', ?) ON DUPLICATE KEY UPDATE v=VALUES(v)", [h]);
    passHash = h; secLog('Password set or changed');
    sessions.clear();          // sign out everywhere else
    startSession(res);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/remove', async (req, res) => {
  if (!passHash) return res.json({ ok: true });
  if (!isAuthed(req)) return res.status(401).json({ error: 'locked' });
  const bad = verifyPassword(req.body.current);
  if (bad) return res.status(bad.code).json({ error: bad.error === 'Wrong password.' ? 'Current password is wrong.' : bad.error });
  try {
    await pool.query("DELETE FROM settings WHERE k='password'");
    passHash = null; sessions.clear(); secLog('Password removed');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- income, trends, CSV import ----------
function vInc(b) {
  const a = Number(b.amount);
  if (!b.source || !String(b.source).trim()) return 'Enter a source.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.received_on || '')) return 'Enter a valid date.';
  if (!Number.isFinite(a) || a <= 0) return 'Amount must be greater than 0.';
  return null;
}

app.get('/api/income', async (req, res) => {
  try {
    const r = monthRange(req.query.month);
    const [rows] = r
      ? await pool.query('SELECT * FROM income WHERE received_on >= ? AND received_on < ? ORDER BY received_on DESC, id DESC', r)
      : await pool.query('SELECT * FROM income ORDER BY received_on DESC, id DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/income/by-month', async (req, res) => {
  const y = Number(req.query.year);
  if (!Number.isInteger(y)) return res.status(400).json({ error: 'Invalid year.' });
  try {
    const [rows] = await pool.query('SELECT MONTH(received_on) AS m, SUM(amount) AS total FROM income WHERE YEAR(received_on)=? GROUP BY m', [y]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/income', async (req, res) => {
  const err = vInc(req.body); if (err) return res.status(400).json({ error: err });
  try {
    const b = req.body;
    const [r] = await pool.query('INSERT INTO income (received_on, source, amount, note, account_id) VALUES (?,?,?,?,?)',
      [b.received_on, b.source.trim(), Number(b.amount), b.note || null, accId(b.account_id)]);
    res.status(201).json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/income/:id', async (req, res) => {
  const err = vInc(req.body); if (err) return res.status(400).json({ error: err });
  try {
    const b = req.body;
    await pool.query('UPDATE income SET received_on=?, source=?, amount=?, note=?, account_id=? WHERE id=?',
      [b.received_on, b.source.trim(), Number(b.amount), b.note || null, accId(b.account_id), req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/income/:id', async (req, res) => {
  try { await pool.query('DELETE FROM income WHERE id=?', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 12 months ending at ?end=YYYY-MM, plus category comparison of the last two months
app.get('/api/trends', async (req, res) => {
  try {
    const end = /^\d{4}-\d{2}$/.test(req.query.end || '') ? req.query.end : localToday().slice(0, 7);
    const [y, m] = end.split('-').map(Number);
    const yms = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(y, m - 1 - i, 1); yms.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); }
    const nd = new Date(y, m, 1), next = `${nd.getFullYear()}-${pad(nd.getMonth() + 1)}-01`;
    const q = (tbl, col) => pool.query(`SELECT DATE_FORMAT(${col}, '%Y-%m') AS ym, SUM(amount) AS t FROM ${tbl} WHERE ${col} >= ? AND ${col} < ? GROUP BY ym`, [yms[0] + '-01', next]);
    const [[sp], [inc]] = await Promise.all([q('expenses', 'spent_on'), q('income', 'received_on')]);
    const [cat] = await pool.query(`SELECT DATE_FORMAT(spent_on, '%Y-%m') AS ym, category, SUM(amount) AS t FROM expenses
      WHERE spent_on >= ? AND spent_on < ? GROUP BY ym, category`, [yms[10] + '-01', next]);
    const get = (rows, ym) => Number((rows.find(r => r.ym === ym) || {}).t || 0);
    const compare = {};
    cat.forEach(r => { (compare[r.category] ||= { category: r.category, prev: 0, cur: 0 })[r.ym === yms[11] ? 'cur' : 'prev'] = Number(r.t); });
    res.json({ months: yms.map(ym => ({ ym, spent: get(sp, ym), income: get(inc, ym) })), compare: Object.values(compare), prevYm: yms[10], curYm: yms[11] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// rows: [{spent_on, title, category, amount, note}] — skips ones that already exist (same date, title, amount)
app.post('/api/import', async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length || rows.length > 20000) return res.status(400).json({ error: 'Send between 1 and 20,000 rows.' });
  const exp = [], inc = [];
  let invalid = 0;
  rows.forEach(r => {
    const acct = accId(r.account_id != null ? r.account_id : req.body.account_id);   // per-row match, else the chosen account
    if (r.type === 'income') { if (vInc(r)) invalid++; else inc.push({ ...r, acct }); }
    else if (validate(r)) invalid++; else exp.push({ ...r, acct });
  });
  if (!exp.length && !inc.length) return res.json({ imported: 0, income: 0, duplicates: 0, invalid });
  const key = (d, t, a) => `${d}|${String(t).trim().toLowerCase()}|${Number(a).toFixed(2)}`;
  const fresh = async (list, dateCol, nameCol, tbl, dField, nField) => {
    if (!list.length) return list;
    const ds = list.map(r => r[dField]).sort();
    const [ex] = await pool.query(`SELECT ${dateCol} AS d, ${nameCol} AS n, amount FROM ${tbl} WHERE ${dateCol} BETWEEN ? AND ?`, [ds[0], ds[ds.length - 1]]);
    const seen = new Set(ex.map(e => key(e.d, e.n, e.amount)));
    return list.filter(r => !seen.has(key(r[dField], r[nField], r.amount)));
  };
  let conn;
  try {
    const fe = await fresh(exp, 'spent_on', 'title', 'expenses', 'spent_on', 'title');
    const fi = await fresh(inc, 'received_on', 'source', 'income', 'received_on', 'source');
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const cats = [...new Set(fe.map(r => String(r.category).trim().slice(0, 50)))];
    if (cats.length) await conn.query('INSERT IGNORE INTO categories (name) VALUES ?', [cats.map(c => [c])]);
    for (let i = 0; i < fe.length; i += 500) {
      await conn.query('INSERT INTO expenses (spent_on, title, category, amount, note, account_id) VALUES ?',
        [fe.slice(i, i + 500).map(r => [r.spent_on, String(r.title).trim().slice(0, 150), String(r.category).trim().slice(0, 50), Number(r.amount), r.note ? String(r.note).slice(0, 255) : null, r.acct])]);
    }
    for (let i = 0; i < fi.length; i += 500) {
      await conn.query('INSERT INTO income (received_on, source, amount, note, account_id) VALUES ?',
        [fi.slice(i, i + 500).map(r => [r.received_on, String(r.source).trim().slice(0, 100), Number(r.amount), r.note ? String(r.note).slice(0, 255) : null, r.acct])]);
    }
    await conn.commit();
    res.json({ imported: fe.length, income: fi.length, duplicates: exp.length - fe.length + inc.length - fi.length, invalid });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    res.status(500).json({ error: 'Import failed, nothing was changed: ' + e.message });
  } finally { if (conn) conn.release(); }
});

// ---------- previously used titles & income sources (type-ahead) ----------
app.get('/api/titles', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT title, category, amount, tags FROM expenses ORDER BY spent_on DESC, id DESC LIMIT 5000');
    const m = new Map();
    rows.forEach(r => {
      const k = r.title.toLowerCase();
      if (!m.has(k)) m.set(k, { title: r.title, category: r.category, amount: r.amount, tags: r.tags, count: 0 });
      m.get(k).count++;
    });
    res.json([...m.values()].sort((a, b) => b.count - a.count).slice(0, 500));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/sources', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT source, amount FROM income ORDER BY received_on DESC, id DESC LIMIT 2000');
    const m = new Map();
    rows.forEach(r => { const k = r.source.toLowerCase(); if (!m.has(k)) m.set(k, { source: r.source, amount: r.amount, count: 0 }); m.get(k).count++; });
    res.json([...m.values()].sort((a, b) => b.count - a.count).slice(0, 200));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/top-titles', async (req, res) => {
  const y = Number(req.query.year);
  if (!Number.isInteger(y)) return res.status(400).json({ error: 'Invalid year.' });
  try {
    const [rows] = await pool.query(`SELECT MIN(title) AS title, COUNT(*) AS n, SUM(amount) AS total, AVG(amount) AS avg
      FROM expenses WHERE spent_on >= ? AND spent_on < ? GROUP BY LOWER(title) ORDER BY total DESC LIMIT 20`, [`${y}-01-01`, `${y + 1}-01-01`]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- tags ----------
app.get('/api/tags', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT tags FROM expenses WHERE tags IS NOT NULL');
    const n = {}; rows.forEach(r => r.tags.split(',').forEach(t => n[t] = (n[t] || 0) + 1));
    res.json(Object.entries(n).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- savings goals ----------
app.get('/api/goals', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT g.*, COALESCE((SELECT SUM(amount) FROM goal_log l WHERE l.goal_id = g.id), 0) AS saved FROM goals g ORDER BY g.id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/goals', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100), target = Number(req.body.target);
  const dl = /^\d{4}-\d{2}-\d{2}$/.test(req.body.deadline || '') ? req.body.deadline : null;
  if (!name) return res.status(400).json({ error: 'Enter a goal name.' });
  if (!Number.isFinite(target) || target <= 0) return res.status(400).json({ error: 'Target must be greater than 0.' });
  try { const [r] = await pool.query('INSERT INTO goals (name, target, deadline) VALUES (?,?,?)', [name, target, dl]); res.status(201).json({ id: r.insertId }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/goals/:id/deposit', async (req, res) => {
  const amt = Number(req.body.amount);
  if (!Number.isFinite(amt) || amt === 0) return res.status(400).json({ error: 'Enter an amount.' });
  try {
    const [[g]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS saved FROM goal_log WHERE goal_id=?', [req.params.id]);
    if (Number(g.saved) + amt < 0) return res.status(400).json({ error: 'You cannot withdraw more than is saved.' });
    await pool.query('INSERT INTO goal_log (goal_id, amount, logged_on) VALUES (?,?,?)', [req.params.id, amt, localToday()]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/goals/:id', async (req, res) => {
  try { await pool.query('DELETE FROM goal_log WHERE goal_id=?', [req.params.id]); await pool.query('DELETE FROM goals WHERE id=?', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- receipts (files stored in ./receipts) ----------
const RECEIPT_DIR = path.join(__dirname, 'receipts');
function sniff(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return ['png', 'image/png'];
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['jpg', 'image/jpeg'];
  if (b.toString('latin1', 0, 4) === 'GIF8') return ['gif', 'image/gif'];
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return ['webp', 'image/webp'];
  if (b.toString('latin1', 0, 4) === '%PDF') return ['pdf', 'application/pdf'];
  return null;
}
const trash = new Map();   // deleted expense id -> time; its receipts are kept for an hour so Undo can restore them
async function purgeTrash(all) {
  const [rows] = await pool.query('SELECT id, expense_id, stored_name FROM attachments WHERE expense_id < 0');
  for (const r of rows) {
    const t = trash.get(-r.expense_id);
    if (!all && t && Date.now() - t < 3600e3) continue;
    try { fs.unlinkSync(path.join(RECEIPT_DIR, r.stored_name)); } catch {}
    await pool.query('DELETE FROM attachments WHERE id=?', [r.id]); trash.delete(-r.expense_id);
  }
}
app.get('/api/expenses/:id/receipts', async (req, res) => {
  try { const [rows] = await pool.query('SELECT id, filename, mime, size FROM attachments WHERE expense_id=? ORDER BY id', [req.params.id]); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/expenses/:id/receipts', express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
  const kind = Buffer.isBuffer(req.body) ? sniff(req.body) : null;
  if (!kind) return res.status(400).json({ error: 'Only PNG, JPG, GIF, WEBP or PDF files up to 15 MB are allowed.' });
  try {
    const [[ex]] = await pool.query('SELECT COUNT(*) AS n FROM expenses WHERE id=?', [req.params.id]);
    if (!ex.n) return res.status(404).json({ error: 'Expense not found.' });
    const [[cnt]] = await pool.query('SELECT COUNT(*) AS n FROM attachments WHERE expense_id=?', [req.params.id]);
    if (cnt.n >= 10) return res.status(400).json({ error: 'At most 10 receipts per expense.' });
    fs.mkdirSync(RECEIPT_DIR, { recursive: true });
    const stored = `${Number(req.params.id)}-${crypto.randomBytes(8).toString('hex')}.${kind[0]}`;
    fs.writeFileSync(path.join(RECEIPT_DIR, stored), req.body);
    let name = 'receipt.' + kind[0];
    try { name = decodeURIComponent(req.headers['x-filename'] || name).replace(/[^\w .()-]/g, '_').slice(0, 150) || name; } catch {}
    await pool.query('INSERT INTO attachments (expense_id, filename, stored_name, mime, size) VALUES (?,?,?,?,?)', [req.params.id, name, stored, kind[1], req.body.length]);
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/receipts/:id', async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT * FROM attachments WHERE id=?', [req.params.id]);
    const file = r && path.join(RECEIPT_DIR, r.stored_name);
    if (!r || !fs.existsSync(file)) return res.status(404).json({ error: 'File not found (is the receipts folder present?).' });
    res.setHeader('Content-Type', r.mime);
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Content-Disposition', `${r.mime === 'application/pdf' ? 'attachment' : 'inline'}; filename="${r.filename.replace(/"/g, '')}"`);
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/receipts/:id', async (req, res) => {
  try {
    const [[r]] = await pool.query('SELECT stored_name FROM attachments WHERE id=?', [req.params.id]);
    if (r) { try { fs.unlinkSync(path.join(RECEIPT_DIR, r.stored_name)); } catch {} await pool.query('DELETE FROM attachments WHERE id=?', [req.params.id]); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- accounts (bank / mobile wallet / credit card / cash) & transfers ----------
const TYPE_LABEL = { bank: 'Bank account', card: 'Credit card', mfs: 'Mobile wallet', cash: 'Cash' };
// balance = starting amount + income - expenses - money sent + money received (transfer fees are recorded as expenses)
const ACCT_BAL = `a.opening_balance
  + COALESCE((SELECT SUM(amount) FROM income i WHERE i.account_id = a.id), 0)
  - COALESCE((SELECT SUM(amount) FROM expenses e WHERE e.account_id = a.id), 0)
  - COALESCE((SELECT SUM(amount) FROM transfers t WHERE t.from_id = a.id), 0)
  + COALESCE((SELECT SUM(amount) FROM transfers t WHERE t.to_id = a.id), 0)`;

async function fixFeeExpenses(q) {   // every transfer fee exists as an expense (category "Fees") on the sending account
  const [rows] = await q.query('SELECT * FROM transfers WHERE fee > 0 AND fee_expense_id IS NULL');
  if (!rows.length) return;
  const cat = await canonCategory('Fees');
  for (const t of rows) {
    const [r] = await q.query('INSERT INTO expenses (spent_on, title, category, amount, note, account_id) VALUES (?,?,?,?,?,?)', [t.moved_on, 'Transfer fee', cat, t.fee, t.note, t.from_id]);
    await q.query('UPDATE transfers SET fee_expense_id=? WHERE id=?', [r.insertId, t.id]);
  }
}
function acctInput(b) {
  const open = Number(b.opening_balance || 0), card = b.type === 'card';
  const provider = String(b.provider || '').trim().slice(0, 60) || null;
  const no = String(b.acct_no || '').replace(/[^\w-]/g, '').slice(-8) || null;
  const name = String(b.name || '').trim().slice(0, 60) || [provider, no && '••' + no].filter(Boolean).join(' ') || TYPE_LABEL[b.type] || 'Account';
  if (!ACCT_TYPES.includes(b.type)) return { error: 'Choose an account type.' };
  if (!Number.isFinite(open)) return { error: 'Enter a valid starting amount.' };
  const limit = card && b.credit_limit !== '' && b.credit_limit != null ? Number(b.credit_limit) : null;
  if (limit !== null && (!Number.isFinite(limit) || limit < 0)) return { error: 'Credit limit must be 0 or more.' };
  const due = card && Number(b.due_day) >= 1 && Number(b.due_day) <= 31 ? Number(b.due_day) : null;
  const ml = b.monthly_limit !== '' && b.monthly_limit != null ? Number(b.monthly_limit) : null;
  if (ml !== null && (!Number.isFinite(ml) || ml < 0)) return { error: 'Monthly limit must be 0 or more.' };
  // for a credit card the starting amount is what you owed, stored as a negative balance
  return { v: [name, b.type, b.type === 'cash' ? null : provider, no, card ? -open : open, limit, due, ml] };
}

app.get('/api/accounts', async (req, res) => {
  try {
    const mr = monthRange(extras.periodKey(localToday()));
    const [rows] = await pool.query(`SELECT a.*, ${ACCT_BAL} AS balance,
      COALESCE((SELECT SUM(amount) FROM expenses m WHERE m.account_id = a.id AND m.spent_on >= ? AND m.spent_on < ?), 0) AS month_spent
      FROM accounts a ORDER BY a.archived, FIELD(a.type, 'bank', 'mfs', 'cash', 'card'), a.name`, mr);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/accounts', async (req, res) => {
  const r = acctInput(req.body); if (r.error) return res.status(400).json({ error: r.error });
  try {
    const [x] = await pool.query('INSERT INTO accounts (name, type, provider, acct_no, opening_balance, credit_limit, due_day, monthly_limit) VALUES (?,?,?,?,?,?,?,?)', r.v);
    res.status(201).json({ id: x.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/accounts/:id', async (req, res) => {
  const r = acctInput(req.body); if (r.error) return res.status(400).json({ error: r.error });
  try {
    await pool.query('UPDATE accounts SET name=?, type=?, provider=?, acct_no=?, opening_balance=?, credit_limit=?, due_day=?, monthly_limit=? WHERE id=?', [...r.v, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/accounts/:id/archive', async (req, res) => {
  try { await pool.query('UPDATE accounts SET archived=? WHERE id=?', [req.body.archived ? 1 : 0, req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// unused account: deleted. Account with history: archived (hidden, history kept, can be restored)
app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [[u]] = await pool.query(`SELECT (SELECT COUNT(*) FROM expenses WHERE account_id=?) + (SELECT COUNT(*) FROM income WHERE account_id=?)
      + (SELECT COUNT(*) FROM transfers WHERE from_id=? OR to_id=?) + (SELECT COUNT(*) FROM recurring WHERE account_id=?) AS n`, [id, id, id, id, id]);
    if (u.n > 0) { await pool.query('UPDATE accounts SET archived=1 WHERE id=?', [id]); return res.json({ archived: true, entries: u.n }); }
    await pool.query('DELETE FROM accounts WHERE id=?', [id]);
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// actual = the real balance (for a card: minus the amount owed). The difference is folded into the starting balance.
app.post('/api/accounts/:id/reconcile', async (req, res) => {
  const actual = Number(req.body.actual);
  if (!Number.isFinite(actual)) return res.status(400).json({ error: 'Enter the real balance.' });
  try {
    const [r] = await pool.query(`SELECT ${ACCT_BAL} AS balance FROM accounts a WHERE a.id=?`, [req.params.id]);
    if (!r.length) return res.status(404).json({ error: 'Account not found.' });
    const diff = Math.round((actual - Number(r[0].balance)) * 100) / 100;
    await pool.query('UPDATE accounts SET opening_balance = opening_balance + ?, reconciled_on = ? WHERE id=?', [diff, localToday(), req.params.id]);
    res.json({ difference: diff });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/accounts/:id/statement', async (req, res) => {
  const range = monthRange(req.query.month);
  if (!range) return res.status(400).json({ error: 'Invalid month.' });
  try {
    const id = Number(req.params.id);
    const [[a]] = await pool.query('SELECT * FROM accounts WHERE id=?', [id]);
    if (!a) return res.status(404).json({ error: 'Account not found.' });
    const [rows] = await pool.query(`
      SELECT 'income' AS kind, id, received_on AS dt, source AS label, amount AS delta FROM income WHERE account_id=?
      UNION ALL SELECT 'expense', id, spent_on, title, -amount FROM expenses WHERE account_id=?
      UNION ALL SELECT 'transfer', t.id, t.moved_on, CONCAT('Transfer to ', ta.name), -t.amount FROM transfers t JOIN accounts ta ON ta.id = t.to_id WHERE t.from_id=?
      UNION ALL SELECT 'transfer', t.id, t.moved_on, CONCAT('Transfer from ', tb.name), t.amount FROM transfers t JOIN accounts tb ON tb.id = t.from_id WHERE t.to_id=?
      ORDER BY dt, id`, [id, id, id, id]);
    let opening = Number(a.opening_balance); const list = [];
    rows.forEach(x => { const d = Number(x.delta); if (x.dt < range[0]) opening += d; else if (x.dt < range[1]) list.push({ kind: x.kind, id: x.id, date: x.dt, label: x.label, delta: d }); });
    let run = opening; list.forEach(x => { run += x.delta; x.balance = Math.round(run * 100) / 100; });
    res.json({ account: a, opening: Math.round(opening * 100) / 100, closing: Math.round(run * 100) / 100, rows: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/networth', async (req, res) => {
  try {
    const [accs] = await pool.query('SELECT id, type, opening_balance FROM accounts WHERE archived=0');
    const grp = (tbl, dateCol, acctCol) => pool.query(`SELECT ${acctCol} AS a, DATE_FORMAT(${dateCol}, '%Y-%m') AS ym, SUM(amount) AS t FROM ${tbl} WHERE ${acctCol} IS NOT NULL GROUP BY a, ym`);
    const [[inc], [exp], [out], [inn]] = await Promise.all([grp('income', 'received_on', 'account_id'), grp('expenses', 'spent_on', 'account_id'), grp('transfers', 'moved_on', 'from_id'), grp('transfers', 'moved_on', 'to_id')]);
    const delta = {};
    const add = (a, ym, v) => { delta[a] = delta[a] || {}; delta[a][ym] = (delta[a][ym] || 0) + v; };
    inc.forEach(r => add(r.a, r.ym, Number(r.t))); inn.forEach(r => add(r.a, r.ym, Number(r.t)));
    exp.forEach(r => add(r.a, r.ym, -Number(r.t))); out.forEach(r => add(r.a, r.ym, -Number(r.t)));
    const [y, m] = localToday().slice(0, 7).split('-').map(Number), r2 = v => Math.round(v * 100) / 100, months = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(y, m - 1 - i, 1); months.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); }
    res.json(months.map(ym => {
      let assets = 0, owed = 0;
      for (const a of accs) {
        let bal = Number(a.opening_balance);
        for (const [mm, v] of Object.entries(delta[a.id] || {})) if (mm <= ym) bal += v;
        if (a.type === 'card') owed -= bal; else assets += bal;
      }
      return { ym, assets: r2(assets), owed: r2(owed), net: r2(assets - owed) };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/transfers', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT t.*, f.name AS from_name, d.name AS to_name FROM transfers t
      JOIN accounts f ON f.id = t.from_id JOIN accounts d ON d.id = t.to_id ORDER BY t.moved_on DESC, t.id DESC LIMIT 100`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/transfers', async (req, res) => {
  const b = req.body, amount = Number(b.amount), fee = Number(b.fee || 0), from = accId(b.from_id), to = accId(b.to_id);
  if (!from || !to || from === to) return res.status(400).json({ error: 'Choose two different accounts.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.moved_on || '')) return res.status(400).json({ error: 'Enter a valid date.' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be greater than 0.' });
  if (!Number.isFinite(fee) || fee < 0) return res.status(400).json({ error: 'Fee must be 0 or more.' });
  try {
    const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM accounts WHERE id IN (?, ?)', [from, to]);
    if (c.n !== 2) return res.status(400).json({ error: 'Account not found.' });
    const [r] = await pool.query('INSERT INTO transfers (moved_on, from_id, to_id, amount, fee, note) VALUES (?,?,?,?,?,?)', [b.moved_on, from, to, amount, fee, b.note ? String(b.note).slice(0, 255) : null]);
    await fixFeeExpenses(pool);
    res.status(201).json({ id: r.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/transfers/:id', async (req, res) => {
  try {
    const [[t]] = await pool.query('SELECT fee_expense_id FROM transfers WHERE id=?', [req.params.id]);
    if (t && t.fee_expense_id) await pool.query('DELETE FROM expenses WHERE id=?', [t.fee_expense_id]);
    await pool.query('DELETE FROM transfers WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- search everything ----------
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const empty = { expenses: [], income: [], transfers: [], accounts: [], goals: [] };
  if (q.length < 2) return res.json(empty);
  try {
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%', num = /^\d+(\.\d+)?$/.test(q) ? Number(q) : -1;
    const [expenses] = await pool.query('SELECT id, spent_on, title, category, amount, note, tags, account_id FROM expenses WHERE title LIKE ? OR note LIKE ? OR category LIKE ? OR tags LIKE ? OR amount = ? ORDER BY spent_on DESC, id DESC LIMIT 30', [like, like, like, like, num]);
    const [income] = await pool.query('SELECT id, received_on, source, amount, note, account_id FROM income WHERE source LIKE ? OR note LIKE ? OR amount = ? ORDER BY received_on DESC, id DESC LIMIT 20', [like, like, num]);
    const [transfers] = await pool.query(`SELECT t.id, t.moved_on, t.amount, t.fee, t.note, f.name AS from_name, d.name AS to_name FROM transfers t
      JOIN accounts f ON f.id = t.from_id JOIN accounts d ON d.id = t.to_id WHERE t.note LIKE ? OR f.name LIKE ? OR d.name LIKE ? OR t.amount = ? ORDER BY t.moved_on DESC LIMIT 20`, [like, like, like, num]);
    const [accounts] = await pool.query('SELECT id, name, type, provider, acct_no FROM accounts WHERE name LIKE ? OR provider LIKE ? OR acct_no LIKE ? LIMIT 20', [like, like, like]);
    const [goals] = await pool.query('SELECT id, name, target FROM goals WHERE name LIKE ? LIMIT 20', [like]);
    res.json({ expenses, income, transfers, accounts, goals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- extra charts ----------
app.get('/api/charts', async (req, res) => {
  const y = Math.trunc(Number(req.query.year));
  if (!Number.isInteger(y)) return res.status(400).json({ error: 'Invalid year.' });
  try {
    const [cats] = await pool.query('SELECT category, SUM(amount) AS t FROM expenses WHERE YEAR(spent_on)=? GROUP BY category ORDER BY t DESC', [y]);
    const [wk] = await pool.query('SELECT DAYOFWEEK(spent_on) AS d, SUM(amount) AS t, COUNT(*) AS n FROM expenses WHERE YEAR(spent_on)=? GROUP BY d', [y]);
    const [mo] = await pool.query('SELECT YEAR(spent_on) AS y, MONTH(spent_on) AS m, SUM(amount) AS t FROM expenses WHERE YEAR(spent_on) IN (?, ?) GROUP BY y, m', [y, y - 1]);
    res.json({ year: y, cats, wk, mo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Excel export (all data, or one year with ?year=2026) ----------
app.get('/api/export.xlsx', async (req, res) => {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); }
  catch { return res.status(500).json({ error: 'Excel export needs one more install step: stop the app, run "npm install", then start it again.' }); }
  try {
    const year = Math.trunc(Number(req.query.year)) || null;
    const W = col => (year ? ` WHERE YEAR(${col}) = ${year}` : '');
    const date = v => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : v; };
    const wb = new ExcelJS.Workbook(); wb.creator = 'Personal Expense Tracker';
    const sheet = (name, cols) => {
      const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = cols.map(c => ({ header: c[0], key: c[1], width: c[2], style: c[3] ? { numFmt: c[3] } : {} }));
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5C4A' } };
      return ws;
    };
    const MONEY = '#,##0.00', DATE = 'yyyy-mm-dd';
    const [ex] = await pool.query(`SELECT e.spent_on, e.title, e.category, a.name AS account, e.amount, e.tags, e.note FROM expenses e LEFT JOIN accounts a ON a.id = e.account_id${W('e.spent_on')} ORDER BY e.spent_on, e.id`);
    const [inc] = await pool.query(`SELECT i.received_on, i.source, a.name AS account, i.amount, i.note FROM income i LEFT JOIN accounts a ON a.id = i.account_id${W('i.received_on')} ORDER BY i.received_on, i.id`);
    const [tr] = await pool.query(`SELECT t.moved_on, f.name AS from_name, d.name AS to_name, t.amount, t.fee, t.note FROM transfers t JOIN accounts f ON f.id = t.from_id JOIN accounts d ON d.id = t.to_id${W('t.moved_on')} ORDER BY t.moved_on, t.id`);
    const [ac] = await pool.query(`SELECT a.name, a.type, a.provider, a.acct_no, a.credit_limit, a.archived, ${ACCT_BAL} AS balance FROM accounts a ORDER BY a.archived, a.type, a.name`);

    // monthly summary and category-by-month grid
    const months = {}, grid = {};
    ex.forEach(r => { const ym = String(r.spent_on).slice(0, 7); (months[ym] = months[ym] || { i: 0, s: 0 }).s += Number(r.amount); ((grid[r.category] = grid[r.category] || {})[ym] = (grid[r.category][ym] || 0) + Number(r.amount)); });
    inc.forEach(r => { const ym = String(r.received_on).slice(0, 7); (months[ym] = months[ym] || { i: 0, s: 0 }).i += Number(r.amount); });
    const yms = Object.keys(months).sort();

    const sm = sheet('Monthly summary', [['Month', 'ym', 12], ['Income', 'i', 16, MONEY], ['Spent', 's', 16, MONEY], ['Net', 'n', 16, MONEY], ['Saved % of income', 'p', 18, '0%']]);
    yms.forEach((ym, k) => sm.addRow({ ym, i: months[ym].i, s: months[ym].s, n: { formula: `B${k + 2}-C${k + 2}`, result: months[ym].i - months[ym].s }, p: { formula: `IF(B${k + 2}=0,0,D${k + 2}/B${k + 2})`, result: months[ym].i ? (months[ym].i - months[ym].s) / months[ym].i : 0 } }));
    if (yms.length) { const n = yms.length + 1; sm.addRow({ ym: 'Total', i: { formula: `SUM(B2:B${n})` }, s: { formula: `SUM(C2:C${n})` }, n: { formula: `SUM(D2:D${n})` } }).font = { bold: true }; }

    const cm = sheet('Category by month', [['Category', 'c', 24], ...yms.map(m => [m, m, 12, MONEY]), ['Total', 't', 14, MONEY]]);
    Object.keys(grid).sort((a, b) => Object.values(grid[b]).reduce((x, y) => x + y, 0) - Object.values(grid[a]).reduce((x, y) => x + y, 0)).forEach(c => {
      const r = cm.addRow({ c, ...grid[c] }), last = String.fromCharCode(65 + yms.length);
      r.getCell(yms.length + 2).value = { formula: `SUM(B${r.number}:${last}${r.number})` };
    });

    const wsE = sheet('Expenses', [['Date', 'spent_on', 12, DATE], ['Title', 'title', 28], ['Category', 'category', 18], ['Account', 'account', 22], ['Amount', 'amount', 14, MONEY], ['Tags', 'tags', 18], ['Note', 'note', 34]]);
    ex.forEach(r => wsE.addRow({ ...r, spent_on: date(r.spent_on), amount: Number(r.amount) }));
    if (ex.length) { wsE.addRow({ title: 'Total', amount: { formula: `SUM(E2:E${ex.length + 1})` } }).font = { bold: true }; wsE.autoFilter = 'A1:G1'; }
    const wsI = sheet('Income', [['Date', 'received_on', 12, DATE], ['Source', 'source', 28], ['Account', 'account', 22], ['Amount', 'amount', 14, MONEY], ['Note', 'note', 34]]);
    inc.forEach(r => wsI.addRow({ ...r, received_on: date(r.received_on), amount: Number(r.amount) }));
    if (inc.length) wsI.addRow({ source: 'Total', amount: { formula: `SUM(D2:D${inc.length + 1})` } }).font = { bold: true };
    const wsA = sheet('Accounts', [['Account', 'name', 26], ['Type', 'type', 14], ['Bank / wallet', 'provider', 22], ['Number (last digits)', 'acct_no', 18], ['Balance (cards: negative = owed)', 'balance', 30, MONEY], ['Credit limit', 'credit_limit', 14, MONEY], ['Archived', 'archived', 10]]);
    ac.forEach(r => wsA.addRow({ ...r, balance: Number(r.balance), credit_limit: r.credit_limit == null ? null : Number(r.credit_limit), archived: r.archived ? 'yes' : '' }));
    const wsT = sheet('Transfers', [['Date', 'moved_on', 12, DATE], ['From', 'from_name', 24], ['To', 'to_name', 24], ['Amount', 'amount', 14, MONEY], ['Fee', 'fee', 10, MONEY], ['Note', 'note', 30]]);
    tr.forEach(r => wsT.addRow({ ...r, moved_on: date(r.moved_on), amount: Number(r.amount), fee: Number(r.fee) }));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="expense-tracker-${year || 'all'}-${localToday()}.xlsx"`);
    await wb.xlsx.write(res); res.end();
  } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); else res.end(); }
});

extras.register(app, { get pool() { return pool; }, canonCategory, localToday, accId });

extras2.register(app, {
  get pool() { return pool; }, localToday, accId, canonCategory, startSession, verifyPassword, isAuthed,
  hasPassword: () => !!passHash, periodKey: extras.periodKey, monthRange: extras.monthRange,
  balances: async () => (await pool.query(`SELECT a.id, a.name, a.type, a.archived, a.credit_limit, ${ACCT_BAL} AS balance FROM accounts a`))[0],
  trashExpenses: async ids => {   // like deleting one expense: receipts are kept for an hour so Undo can bring them back
    await pool.query('UPDATE attachments SET expense_id = -expense_id WHERE expense_id IN (?)', [ids]);
    ids.forEach(i => trash.set(Number(i), Date.now()));
    await pool.query('DELETE FROM expenses WHERE id IN (?)', [ids]);
  },
  paths: { BACKUP_DIR, RECEIPT_DIR }, flags: () => ({ lan: LAN, password: !!passHash, encrypted_backups: !!backupKey }),
});

app.get('/api/export', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT spent_on, title, category, amount, note FROM expenses ORDER BY spent_on');
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['Date,Title,Category,Amount,Note',
      ...rows.map(r => [r.spent_on, r.title, r.category, r.amount, r.note].map(esc).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="expenses.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

init()
  .then(async () => {
    if (process.argv.includes('--backup-now')) {   // used by update.sh / update.bat before an update
      saveBackupFile(`pre-update-${Date.now()}.json`, await buildBackup());
      console.log('Backup saved in the backups folder.'); process.exit(0);
    }
    if (process.argv.includes('--reset-password')) {
      await pool.query("DELETE FROM settings WHERE k='password'");
      console.log('Password removed. Start the app normally with: npm start');
      process.exit(0);
    }
  })
  .then(() => runRecurring().catch(e => console.error('Recurring run failed:', e.message)))
  .then(() => purgeTrash(true).catch(() => {}))
  .then(() => extras.runGoalAuto().catch(() => {}))
  .then(() => setInterval(() => purgeTrash(false).catch(() => {}), 3600e3))
  .then(() => autoBackup().catch(e => console.error('Auto-backup failed:', e.message)))
  .then(() => setInterval(() => autoBackup().catch(() => {}), 6 * 3600 * 1000))
  .then(() => app.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`Expense tracker running at http://localhost:${PORT}`);
    if (LAN) Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal)
      .forEach(i => console.log(`On your phone (same Wi-Fi): http://${i.address}:${PORT}`));
  }))
  .catch(e => {
    console.error('\nCould not connect to MySQL:', e.message);
    console.error('Check that MySQL is running and the user/password in server.js are correct.\n');
    process.exit(1);
  });
