const jwt = require('jsonwebtoken');
const { filterMessage, cleanText } = require('../filters');

const rooms = new Set(['genel', 'turnuva', 'lobi']);
const history = new Map([...rooms].map((room) => [room, []]));
const messageTimes = new Map();

function installChat(io, db, secret, loginProtection, trustedProxyHops = 0) {
  io.use((socket, next) => {
    try {
      const forwarded = String(socket.handshake.headers['x-forwarded-for'] || '').split(',').map((value) => value.trim()).filter(Boolean);
      const proxyIp = trustedProxyHops > 0 ? forwarded[forwarded.length - trustedProxyHops] : null;
      const clientIp = proxyIp || socket.handshake.address || 'unknown';
      if (loginProtection.getBan(clientIp)) return next(new Error('Bu IP geçici olarak engellendi.'));
      const cookie = socket.handshake.headers.cookie || '';
      const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
      const token = socket.handshake.auth?.token || (match ? decodeURIComponent(match[1]) : null);
      if (!token) return next(new Error('Lütfen önce giriş yap.'));
      const payload = jwt.verify(token, secret);
      const session = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(payload.sid);
      if (!session || session.user_id !== Number(payload.sub) || new Date(session.expires_at) <= new Date()) return next(new Error('Oturum kapatılmış veya süresi dolmuş.'));
      const user = db.prepare('SELECT id, username, role, is_banned, ban_reason, ban_until FROM users WHERE id = ?').get(payload.sub);
      if (!user) return next(new Error('Oturum bulunamadı.'));
      if (user.is_banned && (!user.ban_until || new Date(user.ban_until) > new Date())) return next(new Error('Bu hesap sohbetten yasaklandı.'));
      socket.user = user;
      next();
    } catch {
      next(new Error('Oturum geçersiz veya süresi dolmuş.'));
    }
  });

  io.on('connection', (socket) => {
    socket.join('genel');
    socket.emit('room_history', { room: 'genel', messages: history.get('genel') });
    io.emit('online_count', io.engine.clientsCount);

    socket.on('join_room', ({ room } = {}) => {
      if (!rooms.has(room)) return socket.emit('chat_error', 'Bu sohbet odası bulunamadı.');
      for (const joined of socket.rooms) if (rooms.has(joined)) socket.leave(joined);
      socket.join(room);
      socket.emit('room_history', { room, messages: history.get(room) });
      socket.to(room).emit('system_message', `${socket.user.username} odaya katıldı.`);
    });

    socket.on('send_message', ({ room, text } = {}) => {
      if (!rooms.has(room) || !socket.rooms.has(room)) return socket.emit('chat_error', 'Önce geçerli bir odaya katıl.');
      const now = Date.now();
      const recent = (messageTimes.get(socket.user.id) || []).filter((time) => now - time < 10000);
      if (recent.length >= 5 || (recent.length && now - recent[recent.length - 1] < 2000)) return socket.emit('chat_error', 'Mesaj göndermeden önce biraz bekle.');
      const checked = filterMessage(text);
      if (checked.error) return socket.emit('chat_error', checked.error);
      recent.push(now);
      messageTimes.set(socket.user.id, recent);
      const badge = db.prepare('SELECT type, icon, color, name FROM badges WHERE user_id = ? ORDER BY CASE type WHEN \'admin\' THEN 1 WHEN \'mod\' THEN 2 ELSE 3 END LIMIT 1').get(socket.user.id) || null;
      const message = {
        id: `${now}-${socket.id.slice(0, 6)}`,
        userId: socket.user.id,
        username: socket.user.username,
        role: socket.user.role,
        text: checked.text,
        time: new Date(now).toISOString(),
        room,
        badge,
        verified: socket.user.role === 'admin'
      };
      const list = history.get(room);
      list.push(message);
      if (list.length > 100) list.shift();
      io.to(room).emit('new_message', message);
    });

    socket.on('typing', ({ room } = {}) => {
      if (rooms.has(room) && socket.rooms.has(room)) socket.to(room).emit('user_typing', { username: socket.user.username, room });
    });

    socket.on('admin_kick', ({ userId } = {}) => {
      if (!['admin', 'mod'].includes(socket.user.role)) return socket.emit('chat_error', 'Bu işlem için yetkin yok.');
      const target = io.sockets.sockets;
      for (const client of target.values()) if (client.user.id === Number(userId)) {
        client.emit('chat_error', 'Bir yetkili tarafından sohbetten çıkarıldın.');
        client.disconnect(true);
      }
    });

    socket.on('admin_clear', ({ room } = {}) => {
      if (socket.user.role !== 'admin' || !rooms.has(room)) return socket.emit('chat_error', 'Bu işlem için yetkin yok.');
      history.set(room, []);
      io.to(room).emit('room_history', { room, messages: [] });
      db.prepare('INSERT INTO admin_logs (admin_id, action, target) VALUES (?, ?, ?)').run(socket.user.id, 'chat_clear', room);
    });

    socket.on('disconnect', () => io.emit('online_count', io.engine.clientsCount));
  });
}

module.exports = { installChat };