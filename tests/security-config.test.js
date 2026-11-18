const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

assert.doesNotMatch(
  serverSource,
  /password:\s*process\.env\.DB_PASSWORD\s*\|\|\s*['"][^'"]+['"]/,
  'Database password must not have a hard-coded production fallback.'
);

assert.match(
  serverSource,
  /DB_PASSWORD\s*\?\?\s*process\.env\.MYSQL_PASSWORD\s*\?\?\s*''/,
  'Database password should be sourced from environment variables without a hard-coded secret.'
);
