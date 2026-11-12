#!/bin/sh
# One-step updater. Put the new zip next to this file, name it update.zip, run ./update.sh
# It backs up your data first, keeps a copy of the current program, installs the new one and restarts.
cd "$(dirname "$0")" || exit 1
[ -f update.zip ] || { echo "Put the new version here and name it update.zip first."; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "The 'unzip' program is needed."; exit 1; }
STAMP=$(date +%Y%m%d-%H%M%S)
echo "1/5 Backing up your data..."
node server.js --backup-now || { echo "The backup failed, so nothing was changed. Is MySQL running?"; exit 1; }
echo "2/5 Keeping a copy of the current program in previous-versions/ ..."
mkdir -p previous-versions
tar czf "previous-versions/ledger-$STAMP.tar.gz" --exclude=./node_modules --exclude=./previous-versions --exclude=./backups --exclude=./receipts --exclude=./update.zip . || exit 1
echo "3/5 Checking the new version, then stopping the app and installing it..."
rm -rf .update-temp; mkdir .update-temp; unzip -q update.zip -d .update-temp || { echo "Could not open update.zip. Nothing was changed."; rm -rf .update-temp; exit 1; }
SRC=.update-temp; [ -f .update-temp/expense-tracker/server.js ] && SRC=.update-temp/expense-tracker
[ -f "$SRC/server.js" ] || { echo "update.zip does not look like a Personal Expense Tracker zip. Nothing was changed."; rm -rf .update-temp; exit 1; }
PID=$(lsof -ti tcp:3000 -sTCP:LISTEN 2>/dev/null); [ -n "$PID" ] && kill $PID && sleep 2
(cd "$SRC" && tar cf - --exclude=./db-config.json --exclude=./backups --exclude=./receipts --exclude=./node_modules --exclude=./security.log --exclude=./server.log .) | tar xf -
rm -rf .update-temp
echo "4/5 Installing libraries..."
npm install --silent
mv update.zip "update-done-$STAMP.zip"
echo "5/5 Done. Your data, settings and receipts were not touched."
[ "$1" = "--no-start" ] || ./start.sh
