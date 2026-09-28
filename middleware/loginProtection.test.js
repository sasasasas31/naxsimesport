const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createLoginProtection, CAPTCHA_AFTER, BAN_MS } = require('./loginProtection');

function createTestProtection() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE login_attempts (ip_hash TEXT PRIMARY KEY, failed_count INTEGER NOT NULL, window_started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE ip_bans (ip_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  return { db, protection: createLoginProtection(db, 'test-secret-for-hmac-hash-only') };
}

test('CAPTCHA is required after three bad passwords and IP values are stored only as hashes', () => {
  const { db, protection } = createTestProtection();
  const ip = '203.0.113.24';
  for (let attempt = 1; attempt <= CAPTCHA_AFTER; attempt += 1) protection.recordFailure(ip, 1000 + attempt);
  assert.equal(protection.getFailures(ip, 1004), CAPTCHA_AFTER);
  assert.notEqual(db.prepare('SELECT ip_hash FROM login_attempts').get().ip_hash, ip);
  assert.equal(protection.getFailures('203.0.113.25', 1004), 0);
  db.close();
});

test('the tenth bad password bans only that IP for fifteen minutes', () => {
  const { db, protection } = createTestProtection();
  const ip = '203.0.113.24';
  let result;
  for (let attempt = 1; attempt <= 10; attempt += 1) result = protection.recordFailure(ip, 2000 + attempt);
  assert.equal(result.bannedUntil, 2000 + 10 + BAN_MS);
  assert.equal(protection.getBan(ip, 2010).retryAfter, 900);
  assert.equal(protection.getBan('203.0.113.25', 2010), null);
  assert.equal(protection.getBan(ip, 2000 + 10 + BAN_MS), null);
  db.close();
});

test('successful authentication clears failed attempts and temporary ban state', () => {
  const { db, protection } = createTestProtection();
  const ip = '203.0.113.24';
  for (let attempt = 1; attempt <= 10; attempt += 1) protection.recordFailure(ip, 3000 + attempt);
  protection.clearFailures(ip);
  assert.equal(protection.getFailures(ip, 3011), 0);
  assert.equal(protection.getBan(ip, 3011), null);
  db.close();
});