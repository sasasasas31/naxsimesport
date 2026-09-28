const crypto = require('node:crypto');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const BAN_MS = 15 * 60 * 1000;
const CAPTCHA_AFTER = 3;

function createLoginProtection(db, secret) {
  const hashIp = (ip) => crypto.createHmac('sha256', secret).update(ip || 'unknown').digest('hex');

  function getBan(ip, now = Date.now()) {
    const ipHash = hashIp(ip);
    const ban = db.prepare('SELECT expires_at FROM ip_bans WHERE ip_hash = ?').get(ipHash);
    if (!ban) return null;
    if (ban.expires_at <= now) {
      db.prepare('DELETE FROM ip_bans WHERE ip_hash = ?').run(ipHash);
      db.prepare('DELETE FROM login_attempts WHERE ip_hash = ?').run(ipHash);
      return null;
    }
    return { expiresAt: ban.expires_at, retryAfter: Math.ceil((ban.expires_at - now) / 1000) };
  }

  function getFailures(ip, now = Date.now()) {
    const row = db.prepare('SELECT failed_count, window_started_at FROM login_attempts WHERE ip_hash = ?').get(hashIp(ip));
    if (!row || now - row.window_started_at >= WINDOW_MS) return 0;
    return row.failed_count;
  }

  function recordFailure(ip, now = Date.now()) {
    const ipHash = hashIp(ip);
    const previous = db.prepare('SELECT failed_count, window_started_at FROM login_attempts WHERE ip_hash = ?').get(ipHash);
    const started = previous && now - previous.window_started_at < WINDOW_MS ? previous.window_started_at : now;
    const failures = previous && started === previous.window_started_at ? previous.failed_count + 1 : 1;
    db.prepare(`INSERT INTO login_attempts (ip_hash, failed_count, window_started_at, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(ip_hash) DO UPDATE SET
      failed_count = excluded.failed_count, window_started_at = excluded.window_started_at, updated_at = excluded.updated_at`)
      .run(ipHash, failures, started, now);
    if (failures >= MAX_FAILURES) {
      const expiresAt = now + BAN_MS;
      db.prepare(`INSERT INTO ip_bans (ip_hash, expires_at, reason, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(ip_hash) DO UPDATE SET expires_at = excluded.expires_at, reason = excluded.reason, created_at = excluded.created_at`)
        .run(ipHash, expiresAt, '10 başarısız giriş denemesi', now);
      return { failures, bannedUntil: expiresAt };
    }
    return { failures, bannedUntil: null };
  }

  function clearFailures(ip) {
    const ipHash = hashIp(ip);
    db.prepare('DELETE FROM login_attempts WHERE ip_hash = ?').run(ipHash);
    db.prepare('DELETE FROM ip_bans WHERE ip_hash = ?').run(ipHash);
  }

  return { hashIp, getBan, getFailures, recordFailure, clearFailures };
}

module.exports = { createLoginProtection, WINDOW_MS, MAX_FAILURES, BAN_MS, CAPTCHA_AFTER };