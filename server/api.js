const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const sharp = require('sharp');

const router = express.Router();

// ========== 文件上传配置 ==========
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.baseUrl.includes('voice') ? 'voice' : 'images';
    cb(null, path.join(__dirname, '..', 'uploads', type));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const imageTypes = /jpeg|jpg|png|gif|webp/;
    const audioTypes = /webm|mp3|ogg|wav/;
    const ext = path.extname(file.originalname).toLowerCase();
    const isImage = imageTypes.test(ext);
    const isAudio = audioTypes.test(ext);
    if (isImage || isAudio) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件类型'));
    }
  }
});

// ========== 头像上传配置 ==========
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'public', 'avatars'),
    filename: (req, file, cb) => {
      cb(null, `${uuidv4()}.webp`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const imageTypes = /jpeg|jpg|png|gif|webp/;
    const ext = path.extname(file.originalname).toLowerCase();
    if (imageTypes.test(ext)) cb(null, true);
    else cb(new Error('仅支持图片文件'));
  }
});

// ========== 中间件 ==========
function requireAuth(req, res, next) {
  const userId = req.cookies?.user_id;
  if (!userId) return res.status(401).json({ error: '未登录' });
  const user = db.prepare('SELECT id, username, nickname, avatar, bio, is_active FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  if (!user.is_active) return res.status(403).json({ error: '账号已被禁用' });
  req.user = user;
  next();
}

// ========== 用户 API ==========

// 注册
router.post('/register', (req, res) => {
  const { username, password, nickname, id: customId } = req.body;
  if (!username || !password || !nickname) {
    return res.status(400).json({ error: '用户名、密码和昵称不能为空' });
  }
  const userId = customId || uuidv4().slice(0, 8);

  // 检查用户名是否已存在
  const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existingUser) return res.status(400).json({ error: '用户名已被注册' });

  // 检查自定义ID是否已被使用
  const existingId = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (existingId) return res.status(400).json({ error: 'ID已被使用' });

  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (id, username, password, nickname, avatar) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, username, hash, nickname, '/avatars/' + userId + '.webp');

  res.json({ success: true, userId });
});

// 登录
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.status(400).json({ error: '用户名或密码错误' });

  if (!user.is_active) return res.status(403).json({ error: '账号已被禁用，请联系管理员' });

  if (!bcrypt.compareSync(password, user.password)) {
    return res.status(400).json({ error: '用户名或密码错误' });
  }

  db.prepare('UPDATE users SET login_count = login_count + 1, last_active_at = datetime(\'now\', \'localtime\') WHERE id = ?').run(user.id);

  // 设置 cookie（1天）
  res.cookie('user_id', user.id, { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, path: '/' });

  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar,
      bio: user.bio
    }
  });
});

// 登出
router.post('/logout', (req, res) => {
  res.clearCookie('user_id');
  res.json({ success: true });
});

// 获取当前用户信息
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// 搜索用户（通过ID或用户名）
router.get('/users/search', requireAuth, (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ users: [] });

  const users = db.prepare(
    'SELECT id, nickname, avatar, bio FROM users WHERE (id LIKE ? OR nickname LIKE ?) AND id != ? LIMIT 20'
  ).all(`%${q}%`, `%${q}%`, req.user.id);

  res.json({ users });
});

// 上传头像
router.post('/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择图片' });

  const filename = req.user.id + '.webp';
  const outputPath = path.join(__dirname, '..', 'public', 'avatars', filename);

  // 用 sharp 压缩成 webp
  try {
    await sharp(req.file.path).resize(200, 200, { fit: 'cover' }).webp({ quality: 80 }).toFile(outputPath);
    // 删除原始文件
    require('fs').unlinkSync(req.file.path);
  } catch (e) {
    // 如果 sharp 失败，直接用原始文件重命名
    require('fs').renameSync(req.file.path, outputPath);
  }

  const avatarPath = '/avatars/' + filename;
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarPath, req.user.id);
  res.json({ success: true, avatar: avatarPath });
});

// 更新个人资料
router.put('/profile', requireAuth, (req, res) => {
  const { nickname, bio } = req.body;
  if (nickname) db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, req.user.id);
  if (bio !== undefined) db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, req.user.id);
  res.json({ success: true });
});

// ========== 好友 API ==========

// 获取好友列表
router.get('/friends', requireAuth, (req, res) => {
  const friends = db.prepare(`
    SELECT u.id, u.nickname, u.avatar, u.bio, u.last_active_at, f.created_at as friend_since
    FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ?
    ORDER BY u.nickname
  `).all(req.user.id);
  res.json({ friends });
});

// 发送好友请求
router.post('/friend-request', requireAuth, (req, res) => {
  const { targetId } = req.body;
  if (!targetId) return res.status(400).json({ error: '请输入对方ID' });
  if (targetId === req.user.id) return res.status(400).json({ error: '不能添加自己为好友' });

  const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!targetUser) return res.status(404).json({ error: '用户不存在' });

  // 检查是否已经是好友
  const existing = db.prepare(
    'SELECT id FROM friends WHERE user_id = ? AND friend_id = ?'
  ).get(req.user.id, targetId);
  if (existing) return res.status(400).json({ error: '已经是好友了' });

  // 检查是否有待处理的请求
  const pending = db.prepare(
    'SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = ?'
  ).get(req.user.id, targetId, 'pending');
  if (pending) return res.status(400).json({ error: '已经发送过好友请求了' });

  db.prepare(
    'INSERT INTO friend_requests (from_id, to_id) VALUES (?, ?)'
  ).run(req.user.id, targetId);

  res.json({ success: true });
});

// 获取好友请求列表
router.get('/friend-requests', requireAuth, (req, res) => {
  const requests = db.prepare(`
    SELECT fr.id, fr.from_id, fr.status, fr.created_at,
           u.nickname, u.avatar
    FROM friend_requests fr
    JOIN users u ON u.id = fr.from_id
    WHERE fr.to_id = ?
    ORDER BY fr.created_at DESC
  `).all(req.user.id);
  res.json({ requests });
});

// 处理好友请求
router.post('/friend-request/:action', requireAuth, (req, res) => {
  const { action } = req.params; // accept / reject
  const { requestId } = req.body;

  const request = db.prepare(
    'SELECT * FROM friend_requests WHERE id = ? AND to_id = ?'
  ).get(requestId, req.user.id);
  if (!request) return res.status(404).json({ error: '请求不存在' });

  if (action === 'accept') {
    db.prepare('UPDATE friend_requests SET status = ? WHERE id = ?').run('accepted', requestId);
    // 双向添加好友
    db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)').run(req.user.id, request.from_id);
    db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)').run(request.from_id, req.user.id);
  } else {
    db.prepare('UPDATE friend_requests SET status = ? WHERE id = ?').run('rejected', requestId);
  }

  res.json({ success: true });
});

// ========== 群组 API ==========

// 创建群组
router.post('/groups', requireAuth, (req, res) => {
  const { name, memberIds } = req.body;
  if (!name) return res.status(400).json({ error: '群名称不能为空' });

  const groupId = 'g_' + uuidv4().slice(0, 8);
  db.prepare('INSERT INTO groups (id, name, owner_id) VALUES (?, ?, ?)').run(groupId, name, req.user.id);
  // 添加自己为群主
  db.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)').run(groupId, req.user.id, 'owner');

  // 添加成员
  if (memberIds && Array.isArray(memberIds)) {
    const insert = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)');
    memberIds.forEach(mid => insert.run(groupId, mid));
  }

  res.json({ success: true, groupId });
});

// 获取群列表
router.get('/groups', requireAuth, (req, res) => {
  const groups = db.prepare(`
    SELECT g.id, g.name, g.avatar, g.owner_id, g.created_at,
      (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
    FROM group_members gm
    JOIN groups g ON g.id = gm.group_id
    WHERE gm.user_id = ?
    ORDER BY g.created_at DESC
  `).all(req.user.id);
  res.json({ groups });
});

// 获取群详情
router.get('/groups/:groupId', requireAuth, (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).json({ error: '群组不存在' });

  const members = db.prepare(`
    SELECT u.id, u.nickname, u.avatar, u.bio, gm.role, gm.joined_at
    FROM group_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ?
  `).all(req.params.groupId);

  res.json({ group, members });
});

// 添加群成员
router.post('/groups/:groupId/members', requireAuth, (req, res) => {
  const { memberId } = req.body;
  if (!memberId) return res.status(400).json({ error: '请指定成员ID' });

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.groupId);
  if (!group) return res.status(404).json({ error: '群组不存在' });

  db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(req.params.groupId, memberId);
  res.json({ success: true });
});

// ========== 消息 API ==========

// 获取聊天历史
router.get('/messages/:type/:id', requireAuth, (req, res) => {
  const { type, id } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  const before = parseInt(req.query.before);
  const userId = req.user.id;

  let messages;
  if (type === 'private') {
    messages = db.prepare(`
      SELECT m.*, u.nickname as from_nickname, u.avatar as from_avatar
      FROM messages m
      JOIN users u ON u.id = m.from_id
      WHERE (m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?)
      ${before ? 'AND m.id < ?' : ''}
      ORDER BY m.id DESC
      LIMIT ?
    `).all(...(before ? [userId, id, id, userId, before, limit] : [userId, id, id, userId, limit]));
  } else if (type === 'group') {
    messages = db.prepare(`
      SELECT m.*, u.nickname as from_nickname, u.avatar as from_avatar
      FROM messages m
      JOIN users u ON u.id = m.from_id
      WHERE m.group_id = ?
      ${before ? 'AND m.id < ?' : ''}
      ORDER BY m.id DESC
      LIMIT ?
    `).all(...(before ? [id, before, limit] : [id, limit]));
  }

  res.json({ messages: (messages || []).reverse() });
});

// 上传文件（图片/语音）
router.post('/upload/:type', requireAuth, (req, res) => {
  const { type } = req.params; // 'image' 或 'voice'
  const uploadType = type === 'voice' ? 'voice' : 'image';

  const handler = type === 'voice' ? upload : upload;
  handler.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '请选择文件' });

    const fileUrl = `/uploads/${uploadType}s/${req.file.filename}`;
    res.json({ success: true, url: fileUrl });
  });
});

// ========== 管理员 API ==========

// 管理员登录
router.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(400).json({ error: '管理员用户名或密码错误' });
  }
  res.cookie('admin_id', admin.id, { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, path: '/' });
  res.json({ success: true });
});

// 获取所有用户（管理员）
router.get('/admin/users', requireAuth, (req, res) => {
  const users = db.prepare(`
    SELECT id, username, nickname, avatar, bio, is_active, created_at, last_active_at, login_count
    FROM users ORDER BY created_at DESC
  `).all();

  // 添加好友数和群数
  const enriched = users.map(u => {
    const friendCount = db.prepare('SELECT COUNT(*) as c FROM friends WHERE user_id = ?').get(u.id).c;
    const groupCount = db.prepare(`SELECT COUNT(*) as c FROM group_members WHERE user_id = ?`).get(u.id).c;
    const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE from_id = ?').get(u.id).c;
    const isOnline = global.getOnlineUsers ? global.getOnlineUsers().includes(u.id) : false;
    return { ...u, friendCount, groupCount, msgCount, isOnline };
  });

  res.json({ users: enriched });
});

// 启用/禁用用户（管理员）
router.put('/admin/users/:userId/toggle', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const newStatus = user.is_active ? 0 : 1;
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(newStatus, req.params.userId);
  res.json({ success: true, is_active: !!newStatus });
});

module.exports = router;
