# Personal Expense Tracker (HTML/CSS/JS + Node.js + MySQL)

Everything runs on your own PC. No internet needed after setup.

## One-time setup
1. Install **MySQL** (or XAMPP / MySQL Workbench bundle) and make sure it is running.
2. Install **Node.js** (LTS) from nodejs.org.
3. Open this folder in a terminal and run:  `npm install`
   (this is the only step that needs internet)
4. If your MySQL user/password isn't `root` with an empty password, edit the
   `DB` block at the top of `server.js` (or set DB_USER / DB_PASSWORD env vars).

## Run
    npm start
Then open http://localhost:3000

The database `expense_tracker` and its table are created automatically.
Back up your data any time with the "Export CSV" link.

## Features
- Expenses: add / edit / delete, month navigation, per-category totals
- Budgets tab: add your own categories and set a monthly budget for each
  (bars turn red when a category goes over budget)
- Yearly report: monthly totals chart and a category-by-month table
- Export CSV backup
- Search and filter: text search, category filter, optional "search all months"
- Recurring: rent/bills are added automatically on their day each month while the app is running
- Backup tab: download everything as one JSON file, restore from a file; a daily automatic copy goes to the `backups` folder (last 14 kept)
- Security tab: optional password lock (stored as a salted scrypt hash; 5 wrong tries = 1 minute wait).
  Forgot it? Stop the app, run `npm run reset-password`, then `npm start` again.
- Launcher: double-click `start.bat` (Windows) or run `./start.sh`; `create-desktop-shortcut.bat` puts a shortcut on your Desktop
- Budget alerts: banner at 80% and over budget, plus a live hint while typing an expense
- Print / PDF: button on the Expenses tab (choose "Save as PDF" in the print dialog)
- Income tab + net balance on the Expenses summary and in the yearly report
- Trends (Reports tab): 12-month spent vs income chart and this-month vs last-month by category
- CSV import (Backup tab): map columns, skips duplicates
- Tags, savings goals, receipt attachments (receipts folder), security headers, 30-minute idle lock, sign-in log

## Safer MySQL login (recommended)
1. Edit the password in `setup-mysql-user.sql`, then run: `mysql -u root -p < setup-mysql-user.sql`
2. Copy `db-config.example.json` to `db-config.json` and put the same password in it.
3. Restart the app. It now uses the limited `ledger` user instead of `root`.

## Also included
Encrypted backups (Backup tab), recurring income, split expenses, due-soon reminders.
- Title and Category fields remember what you used: pick from the list or type a new one (new categories are created automatically; picking a saved title fills in its category, amount and tags)
- Backup tab: optional encryption of the automatic daily backups

## Using it from your phone (same Wi-Fi)
1. Set a password first (Security tab). Phones are refused until a password exists.
2. In `db-config.json` add `"lan": true` (or start with the environment variable `LAN_ACCESS=1`), restart.
3. The console prints `On your phone: http://192.168.x.x:3000`. Open that on your phone. Allow the Windows Firewall prompt for private networks.
Only home/office (private) network addresses are accepted. The connection is plain HTTP, so use only a Wi-Fi you trust.
- Accounts tab: bank accounts, mobile wallets (bKash/Nagad/Rocket), credit cards (limit, owed, available, due-day reminder) and cash; link each expense/income to an account and move money between accounts (card payments, cash-out with fee)
- Month summary (button on Expenses; also pops up once in the first week of a new month) and Undo after deleting an expense, income or transfer
- Accounts: several banks / mobile wallets (pick or type the bank or MFS name) / credit cards / cash, edit, archive, reconcile with the real balance, per-account statements; recurring items and CSV imports can use an account; transfer fees count as "Fees" expenses; Undo also restores receipts
- Bank-statement import: optional account column is matched to your accounts automatically; money received can be imported as income
- Per-account monthly spending limits with alerts; net-worth history chart (Accounts tab)
- Paste-an-SMS (bKash/Nagad/Rocket/Upay/bank), search-everything box, "safe to spend today", donut/weekday/year-vs-year charts, Excel export (needs `npm install` once more for the exceljs library)

## New in this version
- **Type a sentence** ("tea 20 bkash yesterday"), **auto-categorize rules**, **duplicate finder**, **Test this backup** (Backup tab)
- **Budget month starting on your salary day**, **roll-over budgets**, **suggested budgets**, **monthly set-aside for goals**, **wishlist** with an affordability check
- **Tracker** tab: expenses someone will repay, invoices you sent, warranties (with reminders)
- **Calendar** (Reports tab), **credit card cost calculator** (Accounts tab), **Copy as text** for the month summary
- **Desktop app mode**: run `install-desktop-app.bat` once for a Desktop icon that opens Personal Expense Tracker in its own window and starts everything silently. Or open Personal Expense Tracker in Edge/Chrome and choose Install app. Run `npm install` once after updating (Excel export library).

## Updating without the manual steps
Put the new zip in this folder, name it `update.zip`, then run `update.bat` (Windows) or `./update.sh`. It saves a data backup and a copy of the current program, installs the new version over it (your settings, backups and receipts are kept), runs `npm install` and starts the app.

## Also new
Bulk edit (tick rows on the Expenses tab), saved import setups, keyboard shortcuts (press `?`), pace check, what-if sliders, low-balance alerts, other assets and debts in net worth, project/client profit, expense claim sheet (Tracker tab), Health tab (status + data check), quick PIN and lock-on-tab-switch (Security tab).

## Look and feel
The interface follows a soft purple dashboard style: left sidebar, an Overview page (balance card, cash-flow line, last-costs bars, efficiency ring, category bars) and a right-hand panel with your net for the month and recent activities. It switches to a dark theme automatically when your computer is set to dark mode, and adapts to tablets and phones (the sidebar becomes a scrolling bar across the top). The styling lives in `public/theme.css` and the dashboard in `public/overview.js`.
- Accounts are grouped (Cash, MFS, Bank, Credit cards); click one to open its dashboard: balance, cash in/out, card limit and due date, 6-month chart and recent transactions.
- Account dashboards also have date-range and text filters, an Excel export, a print view, a spent-by-category breakdown and a this-month-vs-last-month comparison.
