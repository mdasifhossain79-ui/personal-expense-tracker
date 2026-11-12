#!/bin/sh
cd "$(dirname "$0")"
[ -d node_modules/exceljs ] || npm install
(sleep 3; (xdg-open http://localhost:3005 || open http://localhost:3006) >/dev/null 2>&1) &
node server.js
