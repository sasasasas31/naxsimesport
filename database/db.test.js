const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db');

test('SQLite enables foreign keys, a busy timeout, and trusted-schema protection', () => {
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
  assert.equal(db.pragma('trusted_schema', { simple: true }), 0);
  assert.equal(db.pragma('secure_delete', { simple: true }), 1);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});