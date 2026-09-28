const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { user: null, socket: null, page: 'dashboard', room: 'genel', tournaments: [], filter: 'all', authMode: 'login', typingTimer: null, captchaRequired: false, captchaId: null, adminUsersPage: 1, adminUsersQuery: '' };
const badgeInfo = {
  admin: { name: 'Admin', icon: '♛', color: '#ff1738', detail: 'Topluluk sahibi ve tam yetkili.' },
  mod: { name: 'Yönetici', icon: '⬟', color: '#4a9eff', detail: 'Topluluk düzenini korur.' },
  season_champion: { name: 'Sezon Şampiyonu', icon: '🏆', color: '#ffd700', detail: 'Sezon turnuvasının şampiyonu.' },
  champion: { name: 'Şampiyon', icon: '★', color: '#b450ff', detail: 'Üç turnuva zaferine ulaştı.' },
  member: { name: 'Üye', icon: '●', color: '#858590', detail: 'Naxsim topluluğunun üyesi.' }
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'İstek tamamlanamadı.');
    error.payload = data;
    throw error;
  }
  return data;
}

function toast(message, isError = false) {
  const region = $('#toast-region');
  const item = element('div', `toast${isError ? ' error' : ''}`, message);
  region.append(item);
  window.setTimeout(() => item.remove(), 3600);
}

function drawLogos() {
  for (const canvas of $$('.brand-canvas')) {
    const context = canvas.getContext('2d');
    if (!context) continue;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    const shield = new Path2D();
    shield.moveTo(width * .5, height * .025);
    shield.lineTo(width * .94, height * .18);
    shield.lineTo(width * .88, height * .65);
    shield.quadraticCurveTo(width * .81, height * .83, width * .5, height * .98);
    shield.quadraticCurveTo(width * .19, height * .83, width * .12, height * .65);
    shield.lineTo(width * .06, height * .18);
    shield.closePath();
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#ff526b');
    gradient.addColorStop(.55, '#ff1738');
    gradient.addColorStop(1, '#9d1028');
    context.fillStyle = gradient;
    context.fill(shield);
    context.strokeStyle = 'rgba(255,255,255,.35)';
    context.lineWidth = Math.max(1, width * .018);
    context.stroke(shield);
    context.save();
    context.translate(width * .5, height * .5);
    context.scale(.78, .78);
    context.translate(-width * .5, -height * .5);
    context.fillStyle = '#101115';
    context.fill(shield);
    context.restore();
    context.fillStyle = '#fff';
    context.font = `800 ${height * .57}px Barlow Condensed, Arial Narrow, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('N', width * .5, height * .52);
  }
}

function setAuthMode(mode) {
  state.authMode = mode;
  $$('.auth-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.authMode === mode));
  $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#password-hint').hidden = mode !== 'register';
  if (!state.captchaRequired) $('#captcha-field').hidden = true;
  if (mode === 'register') {
    state.captchaRequired = false;
    state.captchaId = null;
    $('#captcha-field').hidden = true;
  }
  $('.auth-submit').firstChild.textContent = mode === 'login' ? 'Giriş Yap ' : 'Hesap Oluştur ';
  $('#auth-error').textContent = '';
}

function showApp() {
  $('#auth-screen').hidden = true;
  $('#app-shell').hidden = false;
  const name = state.user.username;
  $('#side-username').textContent = name;
  $('#side-avatar').textContent = name.charAt(0).toUpperCase();
  $('#top-avatar').textContent = name.charAt(0).toUpperCase();
  $('#profile-avatar').textContent = name.charAt(0).toUpperCase();
  const roleNames = { user: 'Üye', mod: 'Yönetici', admin: 'Admin' };
  $('#side-role').textContent = roleNames[state.user.role] || 'Üye';
  const adminLink = $('.admin-nav');
  adminLink.hidden = !['admin', 'mod'].includes(state.user.role);
  adminLink.textContent = state.user.role === 'admin' ? '▤  Admin Panel' : '⬟  Yönetici Panel';
  renderProfile(state.user);
  connectSocket();
  loadDashboard();
}

async function submitAuth(event) {
  event.preventDefault();
  const errorNode = $('#auth-error');
  errorNode.textContent = '';
  const form = new FormData(event.currentTarget);
  try {
    const body = { username: form.get('username'), password: form.get('password') };
    if (state.authMode === 'login' && state.captchaRequired) {
      body.captchaId = state.captchaId;
      body.captchaAnswer = $('#captcha-answer').value;
    }
    const result = await api(`/auth/${state.authMode === 'login' ? 'login' : 'register'}`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    state.captchaRequired = false;
    state.captchaId = null;
    state.user = result.user;
    showApp();
  } catch (error) {
    if (error.payload?.banned) return window.location.assign('/banned.html');
    errorNode.textContent = error.message;
    if (state.authMode === 'login' && error.payload?.captchaRequired) {
      state.captchaRequired = true;
      await loadCaptcha();
    }
  }
}

async function loadCaptcha() {
  state.captchaId = null;
  $('#captcha-field').hidden = false;
  $('#captcha-image').removeAttribute('src');
  try {
    const challenge = await api('/auth/captcha', { method: 'GET', headers: {} });
    state.captchaId = challenge.id;
    $('#captcha-image').src = challenge.image;
    $('#captcha-answer').focus();
  } catch (error) { $('#auth-error').textContent = error.message; }
}

function switchPage(page) {
  if (page === 'admin' && !['admin', 'mod'].includes(state.user.role)) return toast('Bu alana erişim yetkin yok.', true);
  state.page = page;
  $$('.page-view').forEach((view) => view.classList.toggle('active', view.id === `page-${page}`));
  $$('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.page === page));
  const labels = { dashboard: 'GENEL BAKIŞ', chat: 'SOHBET', tournaments: 'TURNUVALAR', rankings: 'SIRALAMA', badges: 'ROZETLER', profile: 'PROFİLİM', admin: 'ADMIN PANEL' };
  $('#breadcrumb-page').textContent = labels[page] || page.toUpperCase();
  $('#sidebar').classList.remove('open');
  if (page === 'chat') { loadChat(); state.socket?.emit('join_room', { room: state.room }); }
  if (page === 'tournaments') loadTournaments();
  if (page === 'rankings') loadRankings();
  if (page === 'badges') loadBadges();
  if (page === 'admin') loadAdmin();
}

function badgeNode(badge, compact = false) {
  const info = badgeInfo[badge.type] || badge;
  const holder = element('span', compact ? 'chat-role-badge' : 'showcase-icon', info.icon || '●');
  holder.style.setProperty('--badge-color', badge.color || info.color);
  holder.title = badge.name || info.name;
  return holder;
}

function renderProfile(user) {
  $('#profile-username').textContent = user.username;
  $('#profile-role').textContent = ({ user: 'ÜYE', mod: 'YÖNETİCİ', admin: 'ADMIN' })[user.role] || 'ÜYE';
  $('#profile-points').textContent = Number(user.points || 0).toLocaleString('tr-TR');
  $('#profile-wins').textContent = user.wins || 0;
  $('#profile-tournaments').textContent = user.tournaments || 0;
  $('#profile-joined').textContent = user.created_at ? new Date(user.created_at).toLocaleDateString('tr-TR', { month: 'short', year: 'numeric' }) : '—';
  const list = $('#profile-badge-list');
  list.replaceChildren();
  const badges = user.badges?.length ? user.badges : [{ type: 'member', name: 'Üye', color: badgeInfo.member.color, icon: badgeInfo.member.icon }];
  for (const badge of badges) {
    const row = element('div', 'profile-badge-row');
    row.append(badgeNode(badge));
    const copy = element('div');
    copy.append(element('strong', '', badge.name || badgeInfo[badge.type]?.name || badge.type));
    copy.append(element('small', '', badgeInfo[badge.type]?.detail || 'Naxsim rozet koleksiyonu.'));
    row.append(copy);
    list.append(row);
  }
}

function renderTournamentCard(tournament, compact = false) {
  const card = element('article', 'tournament-card');
  const name = element('div', 'tournament-name');
  name.append(element('strong', '', tournament.name));
  name.append(element('small', '', `#${tournament.id} · ${tournament.creator_name || 'Naxsim'} tarafından oluşturuldu`));
  const kind = element('span', `tournament-kind${tournament.type === 'normal' ? ' normal' : ''}`, tournament.type === 'season' ? '🏆 Sezon' : '✳ Normal');
  const capacity = element('div', 'tournament-capacity', `${tournament.player_count || 0} / ${tournament.max_players}`);
  capacity.append(element('small', '', 'oyuncu'));
  const status = element('span', `status-label${tournament.status !== 'open' ? ' finished' : ''}`, tournament.status === 'open' ? 'Kayıt açık' : tournament.status === 'finished' ? 'Tamamlandı' : 'İptal edildi');
  const action = element('button', 'tournament-action', tournament.status === 'open' ? (tournament.joined ? 'Katıldın' : 'Katıl') : (tournament.winner_name || 'Sonuç'));
  action.type = 'button';
  action.disabled = tournament.status !== 'open' || Boolean(tournament.joined);
  action.dataset.tournamentAction = tournament.status === 'open' ? 'join' : 'result';
  action.dataset.tournamentId = tournament.id;
  if (!compact) card.append(name, kind, capacity, status, action);
  else card.append(name, capacity, status, action);
  return card;
}

function renderLeaderRow(user, index) {
  const row = element('div', 'leader-row');
  row.append(element('span', 'leader-rank', String(index + 1).padStart(2, '0')));
  const identity = element('div', 'leader-user');
  identity.append(element('span', 'avatar', user.username.charAt(0).toUpperCase()));
  identity.append(element('strong', '', user.username));
  row.append(identity);
  const points = element('span', 'leader-points', Number(user.points || 0).toLocaleString('tr-TR'));
  points.append(element('small', '', ' PUAN'));
  row.append(points);
  return row;
}

async function loadDashboard() {
  try {
    const [tournamentData, rankingData, meData] = await Promise.all([api('/tournaments'), api('/rankings'), api('/auth/me')]);
    state.user = meData.user;
    renderProfile(state.user);
    const open = tournamentData.tournaments.filter((item) => item.status === 'open');
    $('#open-count').textContent = open.length;
    $('#wins-count').textContent = state.user.wins || 0;
    $('#points-count').textContent = Number(state.user.points || 0).toLocaleString('tr-TR');
    $('#tournament-nav-count').textContent = open.length;
    const dashboardTournaments = $('#dashboard-tournaments');
    dashboardTournaments.replaceChildren();
    if (!tournamentData.tournaments.length) dashboardTournaments.append(element('div', 'empty-state', 'Henüz turnuva yok. İlk mücadeleyi sen başlat.'));
    else tournamentData.tournaments.slice(0, 3).forEach((item) => dashboardTournaments.append(renderTournamentCard(item, true)));
    const leaders = $('#dashboard-leaderboard');
    leaders.replaceChildren();
    rankingData.users.slice(0, 5).forEach((user, index) => leaders.append(renderLeaderRow(user, index)));
    state.tournaments = tournamentData.tournaments;
  } catch (error) { toast(error.message, true); }
}

async function loadTournaments() {
  try {
    const { tournaments } = await api('/tournaments');
    state.tournaments = tournaments;
    $('#tournament-nav-count').textContent = tournaments.filter((item) => item.status === 'open').length;
    $('#all-tournament-count').textContent = tournaments.length;
    renderTournamentList();
  } catch (error) { toast(error.message, true); }
}

function renderTournamentList() {
  const list = $('#tournament-list');
  list.replaceChildren();
  const items = state.tournaments.filter((item) => state.filter === 'all' || item.status === state.filter);
  if (!items.length) return list.append(element('div', 'empty-state', 'Bu filtrede turnuva yok. Yeni bir turnuva oluşturabilirsin.'));
  items.forEach((item) => list.append(renderTournamentCard(item)));
}

async function loadRankings() {
  try {
    const { users } = await api('/rankings');
    const list = $('#ranking-list');
    list.replaceChildren();
    if (!users.length) list.append(element('div', 'empty-state', 'Sıralama için henüz oyuncu yok.'));
    users.forEach((user, index) => {
      const row = element('div', 'ranking-row');
      row.append(element('span', 'rank-number', String(index + 1).padStart(2, '0')));
      const player = element('div', 'rank-player');
      player.append(element('span', 'avatar', user.username.charAt(0).toUpperCase()));
      const name = element('strong', '', user.username);
      if (user.role === 'admin') {
        name.append(' ');
        const verified = element('span', 'verified-badge', '✓');
        verified.title = 'Doğrulanmış admin';
        name.append(verified);
      }
      player.append(name);
      row.append(player, element('span', 'rank-data', user.wins || 0), element('span', 'rank-data', user.tournaments || 0));
      const score = element('span', 'rank-score', Number(user.points || 0).toLocaleString('tr-TR'));
      score.append(element('small', '', ' PTS'));
      row.append(score);
      list.append(row);
    });
  } catch (error) { toast(error.message, true); }
}

function loadBadges() {
  const grid = $('#badge-showcase');
  const collection = $('#badge-collection');
  grid.replaceChildren();
  collection.replaceChildren();
  const owned = new Set((state.user.badges || []).map((badge) => badge.type));
  Object.entries(badgeInfo).forEach(([type, info]) => {
    const card = element('article', 'showcase-badge');
    const icon = badgeNode({ type, color: info.color });
    card.append(icon, element('strong', '', info.name), element('small', '', owned.has(type) ? 'Koleksiyonunda' : info.detail));
    card.style.setProperty('--badge-color', info.color);
    grid.append(card);
    const item = element('div', 'collection-item');
    item.append(badgeNode({ type, color: info.color }));
    const copy = element('div');
    copy.append(element('strong', '', info.name), element('small', '', owned.has(type) ? 'Kazanıldı' : 'Henüz kazanılmadı'));
    item.append(copy);
    collection.append(item);
  });
}

function appendChatMessage(message) {
  const list = $('#chat-messages');
  if (list.querySelector('.chat-empty')) list.replaceChildren();
  const row = element('article', 'chat-message');
  row.append(element('span', 'chat-avatar', (message.username || '?').charAt(0).toUpperCase()));
  const body = element('div', 'chat-message-body');
  const head = element('div', 'chat-message-head');
  const username = element('strong', '', message.username || 'Oyuncu');
  if (message.verified) {
    username.append(' ');
    const verified = element('span', 'verified-badge', '✓');
    verified.title = 'Doğrulanmış admin';
    username.append(verified);
  }
  head.append(username);
  if (message.badge) head.append(badgeNode(message.badge, true));
  const date = new Date(message.time);
  head.append(element('time', '', date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })));
  const text = element('p', '', message.text);
  body.append(head, text);
  row.append(body);
  list.append(row);
  list.scrollTop = list.scrollHeight;
}

function appendSystemMessage(text) {
  const list = $('#chat-messages');
  if (list.querySelector('.chat-empty')) list.replaceChildren();
  list.append(element('div', 'system-message', text));
  list.scrollTop = list.scrollHeight;
}

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io({ withCredentials: true });
  state.socket.on('connect', () => {
    state.socket.emit('join_room', { room: state.room });
  });
  state.socket.on('connect_error', (error) => {
    if (state.page === 'chat') toast(error.message, true);
  });
  state.socket.on('online_count', (count) => {
    $('#online-count').textContent = count;
    $('#chat-online-count').textContent = count;
  });
  state.socket.on('room_history', ({ room, messages }) => {
    if (room !== state.room) return;
    const list = $('#chat-messages');
    list.replaceChildren();
    if (!messages.length) list.append(element('div', 'chat-empty', 'İlk mesajı sen gönder.'));
    messages.forEach(appendChatMessage);
  });
  state.socket.on('new_message', (message) => {
    if (message.room === state.room) appendChatMessage(message);
  });
  state.socket.on('system_message', appendSystemMessage);
  state.socket.on('chat_error', (message) => toast(message, true));
  state.socket.on('user_typing', ({ username, room }) => {
    if (room !== state.room) return;
    $('#typing-line').textContent = `${username} yazıyor…`;
    window.clearTimeout(state.typingTimer);
    state.typingTimer = window.setTimeout(() => { $('#typing-line').textContent = ''; }, 1600);
  });
  state.socket.on('tournament_created', () => {
    if (state.page === 'tournaments' || state.page === 'dashboard') loadDashboard();
  });
  state.socket.on('tournament_finished', ({ winner }) => toast(`${winner} turnuvayı kazandı.`));
  state.socket.on('broadcast', ({ text, username }) => toast(`DUYURU · ${username}: ${text}`));
  state.socket.on('user_banned', ({ reason }) => {
    toast(`Hesabın yasaklandı: ${reason}`, true);
    state.socket.disconnect();
    window.location.assign('/banned.html');
  });
}

async function loadChat() {
  $('#active-room-name').textContent = state.room;
  $('#chat-input').placeholder = `#${state.room} kanalına mesaj gönder`;
  $$('.room-button').forEach((button) => button.classList.toggle('active', button.dataset.room === state.room));
  if (!state.socket?.connected) return;
  state.socket.emit('join_room', { room: state.room });
}

async function loadAdmin() {
  try {
    if (state.user.role === 'mod') {
      $('#admin-stats').replaceChildren();
      $('#admin-logs').replaceChildren(element('div', 'empty-state', 'Yönetici işlemleri admin kayıtlarında tutulur.'));
      $('#admin-only-workspace').hidden = true;
      const action = $('#moderation-form [name="action"]');
      action.replaceChildren(new Option('Banla', 'ban'));
      $('#moderation-form [name="days"]').max = '7';
      return;
    }
    $('#admin-only-workspace').hidden = false;
    const [statsResult, logsResult] = await Promise.all([api('/admin/stats'), api('/admin/logs')]);
    const stats = statsResult.stats;
    const target = $('#admin-stats');
    target.replaceChildren();
    [['OYUNCU', stats.users], ['AÇIK TURNUVA', stats.activeTournaments], ['TAMAMLANAN', stats.finishedTournaments], ['YASAKLI HESAP', stats.bannedUsers]].forEach(([label, value]) => {
      const card = element('article', 'admin-stat');
      card.append(element('small', '', label), element('strong', '', String(value)));
      target.append(card);
    });
    const logs = $('#admin-logs');
    logs.replaceChildren();
    if (!logsResult.logs.length) logs.append(element('div', 'empty-state', 'Henüz yönetim kaydı yok.'));
    logsResult.logs.slice(0, 8).forEach((log) => {
      const row = element('div', 'admin-log-row');
      row.append(element('strong', '', `${log.action} · ${log.target || '—'}`), element('time', '', new Date(log.created_at).toLocaleDateString('tr-TR')));
      logs.append(row);
    });
    await Promise.all([loadAdminUsers(), loadAdminBans(), loadAdminTournaments()]);
  } catch (error) { toast(error.message, true); }
}

async function loadAdminUsers(page = state.adminUsersPage) {
  const params = new URLSearchParams({ page: String(page) });
  if (state.adminUsersQuery) params.set('q', state.adminUsersQuery);
  const result = await api(`/admin/users?${params}`);
  state.adminUsersPage = result.page;
  $('#admin-user-total').textContent = `${result.total} hesap`;
  $('#admin-users-page').textContent = `${result.page} / ${result.pages}`;
  $('#admin-users-prev').disabled = result.page <= 1;
  $('#admin-users-next').disabled = result.page >= result.pages;
  const rows = $('#admin-user-rows');
  rows.replaceChildren();
  if (!result.users.length) {
    const row = element('tr');
    const cell = element('td', 'admin-table-empty', 'Oyuncu bulunamadı.');
    cell.colSpan = 4;
    row.append(cell);
    rows.append(row);
    return;
  }
  result.users.forEach((user) => {
    const row = element('tr');
    row.dataset.userId = user.id;
    const identity = element('td', 'admin-user-cell');
    const name = element('strong', '', user.username);
    const metadata = element('small', '', `ID ${user.id} · ${user.points} puan · ${user.wins} zafer`);
    identity.append(name, metadata);
    const role = element('td');
    role.append(element('span', `admin-role role-${user.role}`, ({ admin: 'ADMIN', mod: 'YÖNETİCİ', user: 'ÜYE' })[user.role]));
    const status = element('td');
    status.append(element('span', `admin-user-status${user.is_banned ? ' is-banned' : ''}`, user.is_banned ? 'Yasaklı' : 'Aktif'));
    const actions = element('td', 'admin-user-actions');
    if (user.role !== 'admin' && user.id !== state.user.id) {
      const ban = element('button', 'admin-row-action', user.is_banned ? 'Aç' : 'Ban');
      ban.type = 'button';
      ban.dataset.adminUserAction = user.is_banned ? 'unban' : 'ban';
      ban.title = user.is_banned ? 'Yasağı kaldır' : '1 gün yasakla';
      const promote = element('button', 'admin-row-action', user.role === 'mod' ? 'Üye yap' : 'Mod yap');
      promote.type = 'button';
      promote.dataset.adminUserAction = user.role === 'mod' ? 'user' : 'mod';
      promote.title = user.role === 'mod' ? 'Yönetici yetkisini al' : 'Yönetici yap';
      const remove = element('button', 'admin-row-action danger', 'Sil');
      remove.type = 'button';
      remove.dataset.adminUserAction = 'delete';
      remove.title = 'Hesabı sil';
      actions.append(ban, promote, remove);
    } else actions.append(element('span', 'module-meta', 'Korumalı'));
    row.append(identity, role, status, actions);
    rows.append(row);
  });
}

async function loadAdminBans() {
  const { bans } = await api('/admin/bans');
  const list = $('#admin-ban-list');
  list.replaceChildren();
  const active = bans.filter((ban) => !ban.expires_at || new Date(ban.expires_at) > new Date());
  if (!active.length) return list.append(element('div', 'empty-state', 'Aktif ban kaydı yok.'));
  active.slice(0, 8).forEach((ban) => {
    const row = element('div', 'admin-record-row');
    const copy = element('div');
    copy.append(element('strong', '', ban.username), element('small', '', `${ban.reason} · ${ban.expires_at ? new Date(ban.expires_at).toLocaleString('tr-TR') : 'Kalıcı'}`));
    const unban = element('button', 'admin-row-action', 'Kaldır');
    unban.type = 'button';
    unban.dataset.unbanUserId = ban.user_id;
    row.append(copy, unban);
    list.append(row);
  });
}

async function loadAdminTournaments() {
  const { tournaments } = await api('/admin/tournaments');
  const list = $('#admin-tournament-list');
  list.replaceChildren();
  if (!tournaments.length) return list.append(element('div', 'empty-state', 'Turnuva bulunamadı.'));
  tournaments.slice(0, 10).forEach((tournament) => {
    const row = element('div', 'admin-record-row');
    const copy = element('div');
    const status = ({ open: 'Açık', finished: 'Tamamlandı', cancelled: 'İptal' })[tournament.status];
    copy.append(element('strong', '', tournament.name), element('small', '', `${status} · ${tournament.player_count}/${tournament.max_players} oyuncu · ${tournament.creator_name}`));
    if (tournament.status !== 'finished') {
      const action = element('button', 'admin-row-action', tournament.status === 'open' ? 'İptal' : 'Aç');
      action.type = 'button';
      action.dataset.tournamentId = tournament.id;
      action.dataset.tournamentStatus = tournament.status === 'open' ? 'cancelled' : 'open';
      row.append(copy, action);
    } else row.append(copy, element('span', 'module-meta', tournament.winner_name || 'Sonuçlandı'));
    list.append(row);
  });
}

async function actOnAdminUser(event) {
  const actionButton = event.target.closest('[data-admin-user-action]');
  const unbanButton = event.target.closest('[data-unban-user-id]');
  const row = event.target.closest('[data-user-id]');
  const userId = Number(unbanButton?.dataset.unbanUserId || row?.dataset.userId);
  const action = unbanButton ? 'unban' : actionButton?.dataset.adminUserAction;
  if (!userId || !action) return;
  const username = row?.querySelector('.admin-user-cell strong')?.textContent || 'bu oyuncu';
  try {
    if (action === 'delete') {
      if (!window.confirm(`${username} hesabı kalıcı silinecek. Oluşturduğu turnuvaların sahipliği sana aktarılacak. Devam edilsin mi?`)) return;
      await api(`/admin/user/${userId}`, { method: 'DELETE' });
    } else if (action === 'ban') {
      if (!window.confirm(`${username} 1 gün yasaklansın mı?`)) return;
      await api('/admin/ban', { method: 'POST', body: JSON.stringify({ userId, days: 1, reason: 'Admin paneli işlemi' }) });
    } else if (action === 'unban') {
      await api('/admin/unban', { method: 'POST', body: JSON.stringify({ userId }) });
    } else {
      const nextRole = action === 'mod' ? 'mod' : 'user';
      if (!window.confirm(`${username} hesabının rolü ${nextRole === 'mod' ? 'Yönetici' : 'Üye'} olarak değiştirilsin mi?`)) return;
      await api('/admin/promote', { method: 'POST', body: JSON.stringify({ userId, role: nextRole }) });
    }
    toast('Oyuncu işlemi tamamlandı.');
    await loadAdmin();
  } catch (error) { toast(error.message, true); }
}

async function submitBroadcast(event) {
  event.preventDefault();
  const text = new FormData(event.currentTarget).get('text');
  try {
    await api('/admin/broadcast', { method: 'POST', body: JSON.stringify({ text }) });
    event.currentTarget.reset();
    $('#broadcast-count').textContent = '0 / 500';
    toast('Duyuru çevrimiçi oyunculara gönderildi.');
    loadAdmin();
  } catch (error) { toast(error.message, true); }
}

async function moderateAdminTournament(event) {
  const button = event.target.closest('[data-tournament-status]');
  if (!button) return;
  const status = button.dataset.tournamentStatus;
  if (status === 'cancelled' && !window.confirm('Bu turnuva iptal edilsin mi?')) return;
  try {
    await api(`/admin/tournaments/${button.dataset.tournamentId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    toast(status === 'cancelled' ? 'Turnuva iptal edildi.' : 'Turnuva yeniden açıldı.');
    await loadAdminTournaments();
  } catch (error) { toast(error.message, true); }
}

async function submitTournament(event) {
  event.preventDefault();
  const errorNode = $('#tournament-error');
  errorNode.textContent = '';
  const values = new FormData(event.currentTarget);
  try {
    await api('/tournaments', { method: 'POST', body: JSON.stringify({ name: values.get('name'), maxPlayers: Number(values.get('maxPlayers')), type: values.get('type') }) });
    $('#modal-backdrop').hidden = true;
    event.currentTarget.reset();
    toast('Turnuva oluşturuldu.');
    loadTournaments();
    loadDashboard();
  } catch (error) { errorNode.textContent = error.message; }
}

async function actOnTournament(event) {
  const button = event.target.closest('[data-tournament-action]');
  if (!button || button.dataset.tournamentAction !== 'join') return;
  try {
    await api(`/tournaments/${button.dataset.tournamentId}/join`, { method: 'POST', body: '{}' });
    toast('Turnuvaya katıldın.');
    await loadTournaments();
    loadDashboard();
  } catch (error) { toast(error.message, true); }
}

async function sendChatMessage(event) {
  event.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || !state.socket?.connected) return;
  state.socket.emit('send_message', { room: state.room, text });
  input.value = '';
  $('#chat-char-count').textContent = '0/500';
}

async function submitModeration(event) {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  const userId = Number(values.get('userId'));
  const action = values.get('action');
  try {
    if (action === 'ban' && state.user.role === 'mod') {
      await api('/mod/ban', { method: 'POST', body: JSON.stringify({ userId, days: Number(values.get('days')), reason: values.get('reason') }) });
    } else if (action === 'ban') {
      const days = Number(values.get('days'));
      await api('/admin/ban', { method: 'POST', body: JSON.stringify({ userId, days, reason: values.get('reason') }) });
    } else if (action === 'unban') {
      await api('/admin/unban', { method: 'POST', body: JSON.stringify({ userId }) });
    } else {
      await api('/admin/promote', { method: 'POST', body: JSON.stringify({ userId, role: action }) });
    }
    toast('İşlem tamamlandı.');
    event.currentTarget.reset();
    loadAdmin();
  } catch (error) { toast(error.message, true); }
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST', body: '{}' }); } catch { /* The local session still needs to close if the server is unavailable. */ }
  state.socket?.disconnect();
  state.user = null;
  $('#app-shell').hidden = true;
  $('#auth-screen').hidden = false;
  $('#auth-form').reset();
  setAuthMode('login');
}

function setupEvents() {
  $$('.auth-tab').forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.authMode)));
  $('#auth-form').addEventListener('submit', submitAuth);
  $('#captcha-refresh').addEventListener('click', loadCaptcha);
  $$('.nav-link').forEach((link) => link.addEventListener('click', () => switchPage(link.dataset.page)));
  $$('[data-page-link]').forEach((link) => link.addEventListener('click', () => switchPage(link.dataset.pageLink)));
  $('#menu-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#profile-shortcut').addEventListener('click', () => switchPage('profile'));
  $('#top-avatar').addEventListener('click', () => switchPage('profile'));
  $('#create-tournament-button').addEventListener('click', () => { $('#modal-backdrop').hidden = false; $('#tournament-name').focus(); });
  $('#modal-close').addEventListener('click', () => { $('#modal-backdrop').hidden = true; });
  $('#modal-backdrop').addEventListener('click', (event) => { if (event.target.id === 'modal-backdrop') event.currentTarget.hidden = true; });
  $('#tournament-form').addEventListener('submit', submitTournament);
  $$('.filter-tab').forEach((tab) => tab.addEventListener('click', () => {
    state.filter = tab.dataset.filter;
    $$('.filter-tab').forEach((item) => item.classList.toggle('active', item === tab));
    renderTournamentList();
  }));
  $('#tournament-list').addEventListener('click', actOnTournament);
  $('#dashboard-tournaments').addEventListener('click', actOnTournament);
  $$('.room-button').forEach((button) => button.addEventListener('click', () => { state.room = button.dataset.room; loadChat(); }));
  $('#chat-form').addEventListener('submit', sendChatMessage);
  $('#chat-input').addEventListener('input', (event) => {
    $('#chat-char-count').textContent = `${event.target.value.length}/500`;
    if (event.target.value) state.socket?.emit('typing', { room: state.room });
  });
  $('#moderation-form').addEventListener('submit', submitModeration);
  $('#admin-user-search').addEventListener('submit', (event) => {
    event.preventDefault();
    state.adminUsersQuery = new FormData(event.currentTarget).get('q').trim();
    state.adminUsersPage = 1;
    loadAdminUsers().catch((error) => toast(error.message, true));
  });
  $('#admin-user-rows').addEventListener('click', actOnAdminUser);
  $('#admin-ban-list').addEventListener('click', actOnAdminUser);
  $('#admin-users-prev').addEventListener('click', () => loadAdminUsers(state.adminUsersPage - 1).catch((error) => toast(error.message, true)));
  $('#admin-users-next').addEventListener('click', () => loadAdminUsers(state.adminUsersPage + 1).catch((error) => toast(error.message, true)));
  $('#broadcast-form').addEventListener('submit', submitBroadcast);
  $('#broadcast-text').addEventListener('input', (event) => { $('#broadcast-count').textContent = `${event.target.value.length} / 500`; });
  $('#admin-tournament-list').addEventListener('click', moderateAdminTournament);
  $('#refresh-bans').addEventListener('click', () => loadAdminBans().catch((error) => toast(error.message, true)));
  $('#refresh-admin-tournaments').addEventListener('click', () => loadAdminTournaments().catch((error) => toast(error.message, true)));
  $('#logout-button').addEventListener('click', logout);
  $('#edit-profile-button').addEventListener('click', async () => {
    const username = window.prompt('Yeni kullanıcı adın:', state.user.username);
    if (username === null || username === state.user.username) return;
    try {
      const { user } = await api('/users/me', { method: 'PATCH', body: JSON.stringify({ username }) });
      state.user = { ...state.user, ...user };
      showApp();
      toast('Profilin güncellendi.');
    } catch (error) { toast(error.message, true); }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $('#modal-backdrop').hidden = true;
      $('#sidebar').classList.remove('open');
    }
  });
}

async function boot() {
  drawLogos();
  setupEvents();
  try {
    const { user } = await api('/auth/me');
    state.user = user;
    showApp();
  } catch (error) {
    if (error.payload?.banned) return window.location.assign('/banned.html');
    $('#auth-screen').hidden = false;
  }
}

boot();