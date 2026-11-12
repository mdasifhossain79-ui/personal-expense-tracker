-- Run once as the MySQL admin (root), e.g.:  mysql -u root -p < setup-mysql-user.sql
-- 1) Change CHANGE_ME_STRONG_PASSWORD below.  2) Put the same password in db-config.json.
CREATE DATABASE IF NOT EXISTS expense_tracker;
CREATE USER IF NOT EXISTS 'ledger'@'localhost' IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON expense_tracker.* TO 'ledger'@'localhost';
FLUSH PRIVILEGES;
