const jwt = require('jsonwebtoken');

function tokenFromRequest(req) {
  const authorization = req.get('authorization') || '';
  return req.cookies?.session || (authorization.startsWith('Bearer ') ? authorization.slice(7) : null);
}

function createAuth(db, secret) {
  function resolve(token) {
    if (!token) return null;
    try {
      const payload = jwt.verify(token, secret);
      const session = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(payload.sid);
      if (!session || session.user_id !== Number(payload.sub) || new Date(session.expires_at) <= new Date()) return null;
      return db.prepare('SELECT id, username, role, is_banned, ban_reason, ban_until FROM users WHERE id = ?').get(payload.sub) || null;
    } catch {
      return null;
    }
  }

  function required(req, res, next) {
    const user = resolve(tokenFromRequest(req));
    if (!user) return res.status(401).json({ error: 'Devam etmek için giriş yap.' });
    try { req.sessionId = jwt.verify(tokenFromRequest(req), secret).sid; } catch { return res.status(401).json({ error: 'Oturum geçersiz veya süresi dolmuş.' }); }
    if (user.is_banned && (!user.ban_until || new Date(user.ban_until) > new Date())) {
      return res.status(403).json({ error: `Hesabın yasaklandı: ${user.ban_reason || 'Sebep belirtilmedi'}`, banned: true });
    }
    if (user.is_banned) db.prepare('UPDATE users SET is_banned = 0, ban_reason = NULL, ban_until = NULL WHERE id = ?').run(user.id);
    req.user = user;
    next();
  }

  function roles(...allowed) {
    return (req, res, next) => {
      if (!req.user || !allowed.includes(req.user.role)) return res.status(403).json({ error: 'Bu işlem için yetkin yok.' });
      next();
    };
  }

  return { required, roles, resolve };
}

module.exports = { createAuth, tokenFromRequest };