require('dotenv').config();

const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const svgCaptcha = require('svg-captcha');
const { Server } = require('socket.io');
const db = require('./database/db');
const { createAuth } = require('./middleware/auth');
const { createLoginProtection, CAPTCHA_AFTER } = require('./middleware/loginProtection');
const { entryGuard } = require('./middleware/entryGuard');
const { cleanText } = require('./filters');
const { installChat } = require('./sockets/chat');

const app = express();
const server = http.createServer(app);
const port = Number(process.env.PORT) || 3000;
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters. Set it in .env.');
if (process.env.NODE_ENV === 'production' && !process.env.CLIENT_ORIGIN) throw new Error('CLIENT_ORIGIN must be set in production.');
const trustedProxyHops = Number(process.env.TRUST_PROXY || 0);
if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 5) throw new Error('TRUST_PROXY must be an integer from 0 to 5.');
const origin = process.env.CLIENT_ORIGIN || `http://localhost:${port}`;
const allowedOrigins = new Set([origin]);
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.add(`http://localhost:${port}`);
  allowedOrigins.add(`http://127.0.0.1:${port}`);
}
const io = new Server(server, { cors: { origin: [...allowedOrigins], credentials: true } });
const auth = createAuth(db, secret);
const loginProtection = createLoginProtection(db, secret);
const dummyPasswordHash = bcrypt.hashSync(crypto.randomUUID(), 10);

app.disable('x-powered-by');
app.set('trust proxy', trustedProxyHops);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  }
}));
app.use(cors({ origin: (requestOrigin, callback) => {
  if (!requestOrigin || allowedOrigins.has(requestOrigin)) return callback(null, true);
  return callback(new Error('Origin not allowed'));
}, credentials: true }));
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

function activeAccountBan(user) {
  return Boolean(user?.is_banned && (!user.ban_until || new Date(user.ban_until) > new Date()));
}

function getBanPageUser(req) {
  const token = req.cookies?.session;
  if (!token) return null;
  const sessionUser = auth.resolve(token);
  if (sessionUser) return sessionUser;
  try {
    const payload = jwt.verify(token, secret);
    if (!payload.banNotice) return null;
    return db.prepare('SELECT id, username, role, is_banned, ban_reason, ban_until FROM users WHERE id = ?').get(payload.sub) || null;
  } catch { return null; }
}

function setBanNoticeCookie(res, user) {
  const token = jwt.sign({ sub: user.id, banNotice: true }, secret, { expiresIn: '30d' });
  res.cookie('session', token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

app.use((req, res, next) => {
  if (req.method !== 'GET' || !(req.get('accept') || '').includes('text/html')) return next();
  const user = getBanPageUser(req);
  if (!user) return next();
  if (activeAccountBan(user)) {
    if (req.path === '/banned.html') return next();
    return res.redirect(302, '/banned.html');
  }
  if (user.is_banned) db.prepare('UPDATE users SET is_banned = 0, ban_reason = NULL, ban_until = NULL WHERE id = ?').run(user.id);
  next();
});
app.use(entryGuard);

const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, message: { error: 'Çok fazla giriş isteği. 15 dakika sonra tekrar dene.' }, standardHeaders: 'draft-7', legacyHeaders: false });
const captchaLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, message: { error: 'Çok fazla CAPTCHA isteği. Biraz sonra tekrar dene.' }, standardHeaders: 'draft-7', legacyHeaders: false });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 3, message: { error: 'Kayıt deneme sınırına ulaştın. Bir saat sonra tekrar dene.' }, standardHeaders: 'draft-7', legacyHeaders: false });
const tournamentLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
const modLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api', apiLimiter);
app.use('/api/admin', adminLimiter);
app.use('/api/mod', modLimiter);
app.use('/api', (req, res, next) => {
  const ban = loginProtection.getBan(req.ip);
  if (!ban) return next();
  res.set('Retry-After', String(ban.retryAfter));
  return res.status(429).json({ error: 'Bu IP çok fazla başarısız giriş nedeniyle geçici olarak engellendi.', retryAfter: ban.retryAfter });
});

const userBadge = { type: 'member', name: 'Üye', icon: '●', color: '#858590' };
const badgeDefinitions = {
  admin: { name: 'Admin', icon: '♛', color: '#ff1738' },
  mod: { name: 'Yönetici', icon: '⬟', color: '#4a9eff' },
  season_champion: { name: 'Sezon Şampiyonu', icon: '🏆', color: '#ffd700' },
  champion: { name: 'Şampiyon', icon: '★', color: '#b450ff' },
  member: userBadge
};

function awardBadge(userId, type, awardedBy = null) {
  const badge = badgeDefinitions[type];
  if (!badge) return;
  db.prepare('INSERT OR IGNORE INTO badges (user_id, type, name, icon, color, awarded_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, type, badge.name, badge.icon, badge.color, awardedBy);
}

function publicUser(userId) {
  return db.prepare('SELECT id, username, role, points, wins, tournaments, created_at FROM users WHERE id = ?').get(userId);
}

function signIn(req, res, user) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, user.id, cleanText(req.get('user-agent') || '', 500), req.ip, expiresAt);
  const token = jwt.sign({ sub: user.id, sid: sessionId }, secret, { expiresIn: '30d' });
  res.cookie('session', token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function logAdmin(adminId, action, target, detail = null) {
  db.prepare('INSERT INTO admin_logs (admin_id, action, target, detail) VALUES (?, ?, ?, ?)').run(adminId, action, String(target ?? ''), detail);
}

const adminUsername = process.env.ADMIN_USERNAME;
const adminPassword = process.env.ADMIN_PASSWORD;
if (adminUsername && adminPassword) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername);
  if (!existing) {
    const result = db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)')
      .run(adminUsername, bcrypt.hashSync(adminPassword, 10), 'admin');
    awardBadge(result.lastInsertRowid, 'admin');
  } else if (db.prepare("SELECT id FROM users WHERE id = ? AND role = 'admin'").get(existing.id)) {
    awardBadge(existing.id, 'admin');
  } else {
    throw new Error('ADMIN_USERNAME is already registered as a regular account. Choose another admin username or resolve the account manually.');
  }
}

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/auth/captcha', captchaLimiter, (req, res) => {
  const challenge = svgCaptcha.create({ size: 5, noise: 2, color: true, background: '#f3f3f3', charPreset: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' });
  const id = crypto.randomUUID();
  const answerHash = crypto.createHmac('sha256', secret).update(challenge.text.toLowerCase()).digest('hex');
  const now = Date.now();
  db.prepare('DELETE FROM captcha_challenges WHERE expires_at <= ?').run(now);
  db.prepare('INSERT INTO captcha_challenges (id, ip_hash, answer_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, loginProtection.hashIp(req.ip), answerHash, now + 5 * 60 * 1000, now);
  res.set('Cache-Control', 'no-store');
  res.json({ id, image: `data:image/svg+xml;base64,${Buffer.from(challenge.data).toString('base64')}`, expiresIn: 300 });
});

app.post('/api/auth/register', registerLimiter, async (req, res, next) => {
  try {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = req.body.password;
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Kullanıcı adı 3-20 karakter olmalı; harf, rakam ve _ kullan.' });
    if (adminUsername && username.toLowerCase() === adminUsername.toLowerCase()) return res.status(409).json({ error: 'Bu kullanıcı adı ayrıcalıklı hesap için ayrılmış.' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 72 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Şifre en az 8 karakter, bir büyük harf, bir küçük harf ve bir rakam içermeli.' });
    }
    if (/^(123456|password|qwerty|111111)/i.test(password)) return res.status(400).json({ error: 'Bu şifre çok kolay tahmin ediliyor.' });
    const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, await bcrypt.hash(password, 10));
    awardBadge(result.lastInsertRowid, 'member');
    const user = publicUser(result.lastInsertRowid);
    signIn(req, res, user);
    res.status(201).json({ user });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Bu kullanıcı adı zaten kullanılıyor.' });
    next(error);
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
  try {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
    const failures = loginProtection.getFailures(req.ip);
    if (failures >= CAPTCHA_AFTER) {
      const challengeId = typeof req.body.captchaId === 'string' ? req.body.captchaId : '';
      const answer = typeof req.body.captchaAnswer === 'string' ? req.body.captchaAnswer.trim().toLowerCase() : '';
      const challenge = db.prepare('SELECT * FROM captcha_challenges WHERE id = ? AND ip_hash = ?').get(challengeId, loginProtection.hashIp(req.ip));
      if (challengeId) db.prepare('DELETE FROM captcha_challenges WHERE id = ?').run(challengeId);
      const answerHash = crypto.createHmac('sha256', secret).update(answer).digest('hex');
      const expected = Buffer.from(challenge?.answer_hash || '0'.repeat(64), 'hex');
      const supplied = Buffer.from(answerHash, 'hex');
      const valid = Boolean(challenge && challenge.expires_at > Date.now() && expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied));
      if (!valid) return res.status(400).json({ error: 'CAPTCHA hatalı veya süresi dolmuş. Görseli yenileyip tekrar dene.', captchaRequired: true });
    }
    const passwordMatches = await bcrypt.compare(String(req.body.password || ''), user?.password || dummyPasswordHash);
    if (!user || !passwordMatches) {
      const result = loginProtection.recordFailure(req.ip);
      if (result.bannedUntil) {
        const retryAfter = Math.ceil((result.bannedUntil - Date.now()) / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: '10 başarısız giriş nedeniyle IP adresin 15 dakika engellendi.', retryAfter });
      }
      return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.', captchaRequired: result.failures >= CAPTCHA_AFTER, failedAttempts: result.failures });
    }
    if (activeAccountBan(user)) {
      setBanNoticeCookie(res, user);
      return res.status(403).json({ error: `Hesabın yasaklandı: ${user.ban_reason || 'Sebep belirtilmedi'}`, banned: true });
    }
    loginProtection.clearFailures(req.ip);
    db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    signIn(req, res, user);
    res.json({ user: publicUser(user.id) });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', (req, res) => {
  try {
    const payload = jwt.verify(req.cookies?.session || '', secret);
    if (payload.sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(payload.sid);
  } catch { /* Clearing a missing or invalid cookie is still a successful logout. */ }
  res.clearCookie('session', { httpOnly: true, secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', auth.required, (req, res) => {
  const user = publicUser(req.user.id);
  user.badges = db.prepare('SELECT type, name, icon, color FROM badges WHERE user_id = ? ORDER BY awarded_at').all(user.id);
  res.json({ user });
});

app.get('/api/users/me/sessions', auth.required, (req, res) => {
  const sessions = db.prepare('SELECT id, user_agent, ip, expires_at, created_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id)
    .map((session) => ({ ...session, current: session.id === req.sessionId }));
  res.json({ sessions });
});

app.delete('/api/users/me/sessions/:id', auth.required, (req, res) => {
  const result = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Oturum bulunamadı.' });
  res.json({ ok: true, current: req.params.id === req.sessionId });
});

app.get('/api/tournaments', auth.required, (req, res) => {
  const tournaments = db.prepare(`
    SELECT t.*, creator.username AS creator_name, winner.username AS winner_name,
      (SELECT COUNT(*) FROM tournament_players p WHERE p.tournament_id = t.id) AS player_count,
      EXISTS(SELECT 1 FROM tournament_players p WHERE p.tournament_id = t.id AND p.user_id = ?) AS joined
    FROM tournaments t JOIN users creator ON creator.id = t.creator_id
    LEFT JOIN users winner ON winner.id = t.winner_id
    ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END, t.created_at DESC
  `).all(req.user.id);
  res.json({ tournaments });
});

app.post('/api/tournaments', auth.required, tournamentLimiter, (req, res) => {
  const name = cleanText(req.body.name, 50);
  const maxPlayers = Number(req.body.maxPlayers || 10);
  const type = req.body.type === 'season' ? 'season' : 'normal';
  if (name.length < 3 || !Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 100) return res.status(400).json({ error: 'Turnuva adı 3-50 karakter, oyuncu sayısı 2-100 arasında olmalı.' });
  const create = db.transaction(() => {
    const result = db.prepare('INSERT INTO tournaments (name, max_players, type, creator_id) VALUES (?, ?, ?, ?)').run(name, maxPlayers, type, req.user.id);
    db.prepare('INSERT INTO tournament_players (tournament_id, user_id) VALUES (?, ?)').run(result.lastInsertRowid, req.user.id);
    db.prepare('UPDATE users SET tournaments = tournaments + 1 WHERE id = ?').run(req.user.id);
    return result.lastInsertRowid;
  });
  const id = create();
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
  io.emit('tournament_created', tournament);
  res.status(201).json({ tournament });
});

app.post('/api/tournaments/:id/join', auth.required, (req, res) => {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!tournament || tournament.status !== 'open') return res.status(404).json({ error: 'Açık turnuva bulunamadı.' });
  if (db.prepare('SELECT 1 FROM tournament_players WHERE tournament_id = ? AND user_id = ?').get(tournament.id, req.user.id)) return res.status(409).json({ error: 'Bu turnuvaya zaten katıldın.' });
  const count = db.prepare('SELECT COUNT(*) AS count FROM tournament_players WHERE tournament_id = ?').get(tournament.id).count;
  if (count >= tournament.max_players) return res.status(409).json({ error: 'Turnuva dolu.' });
  db.prepare('INSERT INTO tournament_players (tournament_id, user_id) VALUES (?, ?)').run(tournament.id, req.user.id);
  db.prepare('UPDATE users SET tournaments = tournaments + 1 WHERE id = ?').run(req.user.id);
  io.emit('tournament_joined', { tournamentId: tournament.id, username: req.user.username });
  res.json({ ok: true });
});

app.post('/api/tournaments/:id/leave', auth.required, (req, res) => {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!tournament || tournament.status !== 'open' || tournament.creator_id === req.user.id) return res.status(400).json({ error: 'Bu turnuvadan ayrılamazsın.' });
  const result = db.prepare('DELETE FROM tournament_players WHERE tournament_id = ? AND user_id = ?').run(tournament.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Turnuva katılımı bulunamadı.' });
  db.prepare('UPDATE users SET tournaments = MAX(0, tournaments - 1) WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

app.post('/api/tournaments/:id/win', auth.required, (req, res) => {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  const winnerId = Number(req.body.winnerId);
  if (!tournament || tournament.status !== 'open') return res.status(404).json({ error: 'Açık turnuva bulunamadı.' });
  if (tournament.creator_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Kazananı yalnızca turnuva sahibi veya admin belirleyebilir.' });
  if (!db.prepare('SELECT 1 FROM tournament_players WHERE tournament_id = ? AND user_id = ?').get(tournament.id, winnerId)) return res.status(400).json({ error: 'Kazanan bu turnuvaya katılmamış.' });
  const winner = db.prepare('SELECT id, username, wins FROM users WHERE id = ?').get(winnerId);
  const finish = db.transaction(() => {
    db.prepare("UPDATE tournaments SET status = 'finished', winner_id = ? WHERE id = ?").run(winnerId, tournament.id);
    db.prepare('UPDATE users SET wins = wins + 1, points = points + ? WHERE id = ?').run(tournament.type === 'season' ? 1000 : 100, winnerId);
    if (winner.wins + 1 >= 3) awardBadge(winnerId, 'champion');
    if (tournament.type === 'season') awardBadge(winnerId, 'season_champion');
  });
  finish();
  const badge = tournament.type === 'season' ? badgeDefinitions.season_champion : (winner.wins + 1 >= 3 ? badgeDefinitions.champion : null);
  io.emit('tournament_finished', { winner: winner.username, badge });
  res.json({ ok: true, winner: winner.username, badge });
});

app.delete('/api/tournaments/:id', auth.required, (req, res) => {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(req.params.id);
  if (!tournament) return res.status(404).json({ error: 'Turnuva bulunamadı.' });
  if (tournament.creator_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Bu turnuvayı silemezsin.' });
  db.prepare("UPDATE tournaments SET status = 'cancelled' WHERE id = ?").run(tournament.id);
  res.json({ ok: true });
});

app.get('/api/rankings', auth.required, (req, res) => {
  const users = db.prepare(`SELECT id, username, role, points, wins, tournaments FROM users ORDER BY points DESC, wins DESC, username COLLATE NOCASE LIMIT 50`).all();
  res.json({ users });
});

app.get('/api/rankings/badges', auth.required, (req, res) => {
  const users = db.prepare(`SELECT u.id, u.username, COUNT(b.id) AS badge_count FROM users u LEFT JOIN badges b ON b.user_id = u.id GROUP BY u.id ORDER BY badge_count DESC, u.username LIMIT 50`).all();
  res.json({ users });
});

app.get('/api/users/:id', auth.required, (req, res) => {
  const user = publicUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'Oyuncu bulunamadı.' });
  user.badges = db.prepare('SELECT type, name, icon, color FROM badges WHERE user_id = ?').all(user.id);
  res.json({ user });
});

app.get('/api/users/:id/history', auth.required, (req, res) => {
  const history = db.prepare(`SELECT t.id, t.name, t.type, t.created_at, u.username AS winner_name FROM tournament_players p JOIN tournaments t ON t.id = p.tournament_id LEFT JOIN users u ON u.id = t.winner_id WHERE p.user_id = ? ORDER BY t.created_at DESC LIMIT 50`).all(req.params.id);
  res.json({ history });
});

app.patch('/api/users/me', auth.required, (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Kullanıcı adı 3-20 karakter olmalı; harf, rakam ve _ kullan.' });
  try {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.user.id);
    res.json({ user: publicUser(req.user.id) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Bu kullanıcı adı zaten kullanılıyor.' });
    throw error;
  }
});

app.get('/api/users/me/badges', auth.required, (req, res) => res.json({ badges: db.prepare('SELECT type, name, icon, color, awarded_at FROM badges WHERE user_id = ?').all(req.user.id) }));

function banUser(actor, userId, reason, days) {
  const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
  if (!target) return { error: 'Kullanıcı bulunamadı.', status: 404 };
  if (target.id === actor.id || (actor.role !== 'admin' && target.role !== 'user')) return { error: 'Bu kullanıcı üzerinde işlem yapamazsın.', status: 403 };
  const expiresAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
  db.prepare('UPDATE users SET is_banned = 1, ban_reason = ?, ban_until = ? WHERE id = ?').run(reason, expiresAt, target.id);
  db.prepare('INSERT INTO bans (user_id, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)').run(target.id, reason, actor.id, expiresAt);
  logAdmin(actor.id, 'ban', target.username, `${reason}; days=${days || 'permanent'}`);
  for (const socket of io.sockets.sockets.values()) if (socket.user.id === target.id) {
    socket.emit('user_banned', { userId: target.id, reason });
    socket.disconnect(true);
  }
  return { ok: true };
}

app.post('/api/mod/ban', auth.required, auth.roles('mod', 'admin'), (req, res) => {
  const reason = cleanText(req.body.reason, 200);
  const days = Number(req.body.days);
  if (reason.length < 3 || !Number.isInteger(days) || days < 1 || days > (req.user.role === 'admin' ? 30 : 7)) return res.status(400).json({ error: 'Sebep gerekli; ban süresi 1-7 gün (admin için 1-30) olmalı.' });
  const result = banUser(req.user, Number(req.body.userId), reason, days);
  res.status(result.status || 200).json(result);
});

app.post('/api/admin/ban', auth.required, auth.roles('admin'), (req, res) => {
  const reason = cleanText(req.body.reason, 200);
  const days = req.body.days === null || req.body.days === '' || req.body.days === undefined ? null : Number(req.body.days);
  if (reason.length < 3 || (days !== null && (!Number.isInteger(days) || days < 1 || days > 30))) return res.status(400).json({ error: 'Sebep gerekli; süre 1-30 gün veya kalıcı olmalı.' });
  const result = banUser(req.user, Number(req.body.userId), reason, days);
  res.status(result.status || 200).json(result);
});

app.post('/api/admin/unban', auth.required, auth.roles('admin'), (req, res) => {
  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(req.body.userId));
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  db.prepare('UPDATE users SET is_banned = 0, ban_reason = NULL, ban_until = NULL WHERE id = ?').run(target.id);
  const now = new Date().toISOString();
  db.prepare('UPDATE bans SET expires_at = ? WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)').run(now, target.id, now);
  logAdmin(req.user.id, 'unban', target.username);
  res.json({ ok: true });
});

app.post('/api/admin/promote', auth.required, auth.roles('admin'), (req, res) => {
  const userId = Number(req.body.userId);
  const role = req.body.role;
  if (!['mod', 'user'].includes(role) || userId === req.user.id) return res.status(400).json({ error: 'Geçersiz rol veya hedef kullanıcı.' });
  const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
  if (!target || target.role === 'admin') return res.status(404).json({ error: 'Kullanıcı bulunamadı veya admin rolü değiştirilemez.' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  if (role === 'mod') awardBadge(userId, 'mod', req.user.id);
  else db.prepare("DELETE FROM badges WHERE user_id = ? AND type = 'mod'").run(userId);
  logAdmin(req.user.id, role === 'mod' ? 'promote_mod' : 'demote_mod', target.username);
  res.json({ ok: true });
});

app.get('/api/admin/users', auth.required, auth.roles('admin'), (req, res) => {
  const query = cleanText(req.query.q, 40);
  const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
  const limit = 25;
  const where = query ? 'WHERE username LIKE ? ESCAPE \'\\\'' : '';
  const search = query ? `%${query.replace(/[\\%_]/g, '\\$&')}%` : null;
  const total = db.prepare(`SELECT COUNT(*) AS count FROM users ${where}`).get(...(search ? [search] : [])).count;
  const users = db.prepare(`SELECT id, username, role, points, wins, tournaments, is_banned, ban_reason, ban_until, created_at, last_login
    FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...(search ? [search, limit, (page - 1) * limit] : [limit, (page - 1) * limit]));
  res.json({ users, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
});

app.get('/api/admin/tournaments', auth.required, auth.roles('admin'), (req, res) => {
  const tournaments = db.prepare(`SELECT t.id, t.name, t.status, t.type, t.max_players, t.created_at,
    creator.username AS creator_name, winner.username AS winner_name,
    (SELECT COUNT(*) FROM tournament_players p WHERE p.tournament_id = t.id) AS player_count
    FROM tournaments t JOIN users creator ON creator.id = t.creator_id
    LEFT JOIN users winner ON winner.id = t.winner_id
    ORDER BY t.created_at DESC LIMIT 100`).all();
  res.json({ tournaments });
});

app.patch('/api/admin/tournaments/:id/status', auth.required, auth.roles('admin'), (req, res) => {
  const status = req.body.status;
  if (!['open', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Turnuva yalnızca açılabilir veya iptal edilebilir.' });
  const tournament = db.prepare('SELECT id, name, status FROM tournaments WHERE id = ?').get(req.params.id);
  if (!tournament) return res.status(404).json({ error: 'Turnuva bulunamadı.' });
  if (tournament.status === 'finished') return res.status(409).json({ error: 'Tamamlanmış turnuva yeniden açılamaz veya iptal edilemez.' });
  db.prepare('UPDATE tournaments SET status = ? WHERE id = ?').run(status, tournament.id);
  logAdmin(req.user.id, status === 'cancelled' ? 'cancel_tournament' : 'reopen_tournament', tournament.name);
  res.json({ ok: true });
});

app.post('/api/admin/broadcast', auth.required, auth.roles('admin'), (req, res) => {
  const text = cleanText(req.body.text, 500);
  if (text.length < 3) return res.status(400).json({ error: 'Duyuru en az 3 karakter olmalı.' });
  io.emit('broadcast', { text, username: req.user.username, time: new Date().toISOString() });
  logAdmin(req.user.id, 'broadcast', 'all', text.slice(0, 160));
  res.json({ ok: true });
});

app.delete('/api/admin/user/:id', auth.required, auth.roles('admin'), (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
  if (target.id === req.user.id || target.role === 'admin') return res.status(403).json({ error: 'Kendi hesabını veya başka bir admin hesabını silemezsin.' });
  const removeUser = db.transaction(() => {
    db.prepare('UPDATE tournaments SET creator_id = ? WHERE creator_id = ?').run(req.user.id, target.id);
    db.prepare('UPDATE tournaments SET winner_id = NULL WHERE winner_id = ?').run(target.id);
    db.prepare('DELETE FROM tournament_players WHERE user_id = ?').run(target.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    logAdmin(req.user.id, 'delete_user', target.username, 'Tournament ownership transferred to acting admin');
  });
  removeUser();
  for (const socket of io.sockets.sockets.values()) if (socket.user.id === target.id) {
    socket.emit('user_banned', { userId: target.id, reason: 'Hesabın yönetim tarafından silindi.' });
    socket.disconnect(true);
  }
  res.json({ ok: true });
});

app.get('/api/admin/stats', auth.required, auth.roles('admin'), (req, res) => {
  res.json({ stats: {
    users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    activeTournaments: db.prepare("SELECT COUNT(*) AS count FROM tournaments WHERE status = 'open'").get().count,
    finishedTournaments: db.prepare("SELECT COUNT(*) AS count FROM tournaments WHERE status = 'finished'").get().count,
    bannedUsers: db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_banned = 1').get().count
  } });
});

app.get('/api/admin/bans', auth.required, auth.roles('admin'), (req, res) => res.json({ bans: db.prepare('SELECT b.*, u.username, a.username AS admin_name FROM bans b JOIN users u ON u.id = b.user_id LEFT JOIN users a ON a.id = b.banned_by ORDER BY b.created_at DESC LIMIT 100').all() }));
app.get('/api/admin/logs', auth.required, auth.roles('admin'), (req, res) => res.json({ logs: db.prepare('SELECT l.*, u.username AS admin_name FROM admin_logs l LEFT JOIN users u ON u.id = l.admin_id ORDER BY l.created_at DESC LIMIT 100').all() }));

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint bulunamadı.' }));
app.get('/blocked', (req, res) => res.sendFile(require('node:path').join(__dirname, 'public', 'blocked.html')));
app.get(['/banned', '/banned.html'], (req, res) => {
  const user = getBanPageUser(req);
  if (!activeAccountBan(user)) {
    if (user?.is_banned) db.prepare('UPDATE users SET is_banned = 0, ban_reason = NULL, ban_until = NULL WHERE id = ?').run(user.id);
    return res.redirect(302, '/');
  }
  res.set('Cache-Control', 'no-store');
  res.sendFile(require('node:path').join(__dirname, 'public', 'banned.html'));
});
app.use(express.static(require('node:path').join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(require('node:path').join(__dirname, 'public', 'index.html')));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.type === 'entity.parse.failed' ? 400 : 500;
  res.status(status).json({ error: status === 400 ? 'Geçersiz istek gövdesi.' : 'Sunucu tarafında beklenmeyen bir hata oluştu.' });
});

installChat(io, db, secret, loginProtection, trustedProxyHops);
server.listen(port, '0.0.0.0', () => process.stdout.write(`Naxsim E-Sports running at http://localhost:${port}\n`));