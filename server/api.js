const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, run } = require('./db');
const fs = require('fs');

const router = express.Router();

// ========== 上传配置 ==========
// 本地模式：直接存文件；生产模式：base64 存消息表里的 file_data 字段
const USE_DB_STORAGE = !!process.env.TURSO_DB_URL;

const uploadTmp = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'uploads'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (/jpeg|jpg|png|gif|webp|webm|mp3|ogg|wav/.test(ext)) cb(null, true);
    else cb(new Error('不支持的文件类型'));
  }
});

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '..', 'public', 'avatars'),
    filename: (req, file, cb) => cb(null, `${uuidv4()}.webp`)
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (/jpeg|jpg|png|gif|webp/.test(ext)) cb(null, true);
    else cb(new Error('仅支持图片文件'));
  }
});

// 如果是用 Turso，给 messages 表加一个 file_data 列存 base64
if (USE_DB_STORAGE) {
  run('ALTER TABLE messages ADD COLUMN file_data TEXT DEFAULT NULL').catch(() => {});
}

// ========== 中间件 ==========
async function requireAuth(req, res, next) {
  const userId = req.cookies?.user_id;
  if (!userId) return res.status(401).json({ error: '未登录' });
  const user = await queryOne('SELECT id, username, nickname, avatar, bio, is_active FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  if (!user.is_active) return res.status(403).json({ error: '账号已被禁用' });
  req.user = user;
  next();
}

// ========== 用户 API ==========

router.post('/register', async (req, res) => {
  try {
    const { username, password, nickname, id: customId } = req.body;
    if (!username || !password || !nickname) return res.status(400).json({ error: '用户名、密码和昵称不能为空' });
    const userId = customId || uuidv4().slice(0, 8);
    if (await queryOne('SELECT id FROM users WHERE username = ?', [username]))
      return res.status(400).json({ error: '用户名已被注册' });
    if (await queryOne('SELECT id FROM users WHERE id = ?', [userId]))
      return res.status(400).json({ error: 'ID已被使用' });
    const hash = bcrypt.hashSync(password, 10);
    await run('INSERT INTO users (id, username, password, nickname, avatar) VALUES (?, ?, ?, ?, ?)',
      [userId, username, hash, nickname, '/avatars/' + userId + '.webp']);
    res.json({ success: true, userId });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await queryOne('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) return res.status(400).json({ error: '用户名或密码错误' });
    if (!user.is_active) return res.status(403).json({ error: '账号已被禁用' });
    if (!bcrypt.compareSync(password, user.password)) return res.status(400).json({ error: '用户名或密码错误' });
    await run("UPDATE users SET login_count = login_count + 1, last_active_at = datetime('now', 'localtime') WHERE id = ?", [user.id]);
    res.cookie('user_id', user.id, { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, path: '/' });
    res.json({ success: true, user: { id: user.id, username: user.username, nickname: user.nickname, avatar: user.avatar, bio: user.bio } });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('user_id');
  res.json({ success: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

router.get('/users/search', requireAuth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ users: [] });
    const users = await query('SELECT id, nickname, avatar, bio FROM users WHERE (id LIKE ? OR nickname LIKE ?) AND id != ? LIMIT 20',
      [`%${q}%`, `%${q}%`, req.user.id]);
    res.json({ users });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

router.post('/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请选择图片' });
    const ext = path.extname(req.file.path);
    // 用 sharp 压缩
    let finalPath = req.file.path;
    try {
      const sharp = require('sharp');
      const webpPath = req.file.path.replace(ext, '.webp');
      await sharp(req.file.path).resize(200, 200, { fit: 'cover' }).webp({ quality: 80 }).toFile(webpPath);
      fs.unlinkSync(req.file.path);
      finalPath = webpPath;
    } catch (e) { /* sharp 失败就用原文件 */ }

    const filename = req.user.id + '-' + path.basename(finalPath);
    const outputPath = path.join(__dirname, '..', 'public', 'avatars', filename);
    fs.renameSync(finalPath, outputPath);
    const avatarPath = '/avatars/' + filename;
    await run('UPDATE users SET avatar = ? WHERE id = ?', [avatarPath, req.user.id]);
    res.json({ success: true, avatar: avatarPath });
  } catch (err) { res.status(500).json({ error: '上传失败' }); }
});

router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { nickname, bio } = req.body;
    if (nickname) await run('UPDATE users SET nickname = ? WHERE id = ?', [nickname, req.user.id]);
    if (bio !== undefined) await run('UPDATE users SET bio = ? WHERE id = ?', [bio, req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

// ========== 好友 API ==========

router.get('/friends', requireAuth, async (req, res) => {
  try {
    const friends = await query(
      `SELECT u.id, u.nickname, u.avatar, u.bio, u.last_active_at, f.created_at as friend_since
       FROM friends f JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ? ORDER BY u.nickname`, [req.user.id]);
    res.json({ friends });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

router.post('/friend-request', requireAuth, async (req, res) => {
  try {
    const { targetId } = req.body;
    if (!targetId) return res.status(400).json({ error: '请输入对方ID' });
    if (targetId === req.user.id) return res.status(400).json({ error: '不能添加自己为好友' });
    if (!await queryOne('SELECT id FROM users WHERE id = ?', [targetId]))
      return res.status(404).json({ error: '用户不存在' });
    if (await queryOne('SELECT id FROM friends WHERE user_id = ? AND friend_id = ?', [req.user.id, targetId]))
      return res.status(400).json({ error: '已经是好友了' });
    if (await queryOne("SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = ?", [req.user.id, targetId, 'pending']))
      return res.status(400).json({ error: '已经发送过好友请求了' });
    await run('INSERT INTO friend_requests (from_id, to_id) VALUES (?, ?)', [req.user.id, targetId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

router.get('/friend-requests', requireAuth, async (req, res) => {
  try {
    const requests = await query(
      `SELECT fr.id, fr.from_id, fr.status, fr.created_at, u.nickname, u.avatar
       FROM friend_requests fr JOIN users u ON u.id = fr.from_id
       WHERE fr.to_id = ? ORDER BY fr.created_at DESC`, [req.user.id]);
    res.json({ requests });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

router.post('/friend-request/:action', requireAuth, async (req, res) => {
  try {
    const { action } = req.params;
    const { requestId } = req.body;
    const request = await queryOne('SELECT * FROM friend_requests WHERE id = ? AND to_id = ?', [requestId, req.user.id]);
    if (!request) return res.status(404).json({ error: '请求不存在' });
    if (action === 'accept') {
      await run('UPDATE friend_requests SET status = ? WHERE id = ?', ['accepted', requestId]);
      await run('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)', [req.user.id, request.from_id]);
      await run('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)', [request.from_id, req.user.id]);
    } else {
      await run('UPDATE friend_requests SET status = ? WHERE id = ?', ['rejected', requestId]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

// ========== 群组 API ==========

router.post('/groups', requireAuth, async (req, res) => {
  try {
    const { name, memberIds } = req.body;
    if (!name) return res.status(400).json({ error: '群名称不能为空' });
    const groupId = 'g_' + uuidv4().slice(0, 8);
    await run('INSERT INTO groups_table (id, name, owner_id) VALUES (?, ?, ?)', [groupId, name, req.user.id]);
    await run('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', [groupId, req.user.id, 'owner']);
    if (memberIds && Array.isArray(memberIds)) {
      for (const mid of memberIds) await run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, mid]);
    }
    res.json({ success: true, groupId });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

router.get('/groups', requireAuth, async (req, res) => {
  try {
    const groups = await query(
      `SELECT g.id, g.name, g.avatar, g.owner_id, g.created_at,
        (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
       FROM group_members gm JOIN groups_table g ON g.id = gm.group_id
       WHERE gm.user_id = ? ORDER BY g.created_at DESC`, [req.user.id]);
    res.json({ groups });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

router.get('/groups/:groupId', requireAuth, async (req, res) => {
  try {
    const group = await queryOne('SELECT * FROM groups_table WHERE id = ?', [req.params.groupId]);
    if (!group) return res.status(404).json({ error: '群组不存在' });
    const members = await query(
      `SELECT u.id, u.nickname, u.avatar, u.bio, gm.role, gm.joined_at
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ?`, [req.params.groupId]);
    res.json({ group, members });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

router.post('/groups/:groupId/members', requireAuth, async (req, res) => {
  try {
    const { memberId } = req.body;
    if (!memberId) return res.status(400).json({ error: '请指定成员ID' });
    if (!await queryOne('SELECT * FROM groups_table WHERE id = ?', [req.params.groupId]))
      return res.status(404).json({ error: '群组不存在' });
    await run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', [req.params.groupId, memberId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

// ========== 消息 API ==========

router.get('/messages/:type/:id', requireAuth, async (req, res) => {
  try {
    const { type, id } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const before = parseInt(req.query.before);
    const userId = req.user.id;
    let messages;

    if (type === 'private') {
      const params = before ? [userId, id, id, userId, before, limit] : [userId, id, id, userId, limit];
      messages = await query(
        `SELECT m.*, u.nickname as from_nickname, u.avatar as from_avatar
         FROM messages m JOIN users u ON u.id = m.from_id
         WHERE ((m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?)) ${before ? 'AND m.id < ?' : ''}
         ORDER BY m.id DESC LIMIT ?`, params);
    } else {
      const params = before ? [id, before, limit] : [id, limit];
      messages = await query(
        `SELECT m.*, u.nickname as from_nickname, u.avatar as from_avatar
         FROM messages m JOIN users u ON u.id = m.from_id
         WHERE m.group_id = ? ${before ? 'AND m.id < ?' : ''}
         ORDER BY m.id DESC LIMIT ?`, params);
    }
    res.json({ messages: (messages || []).reverse() });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

// 上传图片/语音（本地存文件；生产模式存 base64）
router.post('/upload/:type', requireAuth, uploadTmp.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请选择文件' });
    const uploadType = req.params.type === 'voice' ? 'voice' : 'image';

    if (USE_DB_STORAGE) {
      // 生产模式：读文件转 base64，存数据库
      const data = fs.readFileSync(req.file.path);
      const b64 = data.toString('base64');
      const mime = uploadType === 'voice' ? 'audio/webm' : 'image/webp';
      const dataUrl = `data:${mime};base64,${b64}`;
      fs.unlinkSync(req.file.path);
      // 返回一个特殊的 data: URL，前端直接用它
      res.json({ success: true, url: dataUrl, isDataUrl: true });
    } else {
      // 本地模式：直接返回文件 URL
      const dir = path.join(__dirname, '..', 'uploads', uploadType + 's');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const newPath = path.join(dir, req.file.filename);
      fs.renameSync(req.file.path, newPath);
      const fileUrl = `/uploads/${uploadType}s/${req.file.filename}`;
      res.json({ success: true, url: fileUrl });
    }
  } catch (err) {
    res.status(500).json({ error: '上传失败' });
  }
});

// ========== 管理员 API ==========

router.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await queryOne('SELECT * FROM admin_users WHERE username = ?', [username]);
    if (!admin || !bcrypt.compareSync(password, admin.password))
      return res.status(400).json({ error: '管理员用户名或密码错误' });
    res.cookie('admin_id', admin.id, { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, path: '/' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

router.get('/admin/users', requireAuth, async (req, res) => {
  try {
    const users = await query('SELECT id, username, nickname, avatar, bio, is_active, created_at, last_active_at, login_count FROM users ORDER BY created_at DESC');
    const enriched = [];
    for (const u of users) {
      const friendCount = (await queryOne('SELECT COUNT(*) as c FROM friends WHERE user_id = ?', [u.id])).c;
      const groupCount = (await queryOne('SELECT COUNT(*) as c FROM group_members WHERE user_id = ?', [u.id])).c;
      const msgCount = (await queryOne('SELECT COUNT(*) as c FROM messages WHERE from_id = ?', [u.id])).c;
      const isOnline = global.getOnlineUsers ? global.getOnlineUsers().includes(u.id) : false;
      enriched.push({ ...u, friendCount, groupCount, msgCount, isOnline });
    }
    res.json({ users: enriched });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

router.put('/admin/users/:userId/toggle', requireAuth, async (req, res) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.userId]);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    const newStatus = user.is_active ? 0 : 1;
    await run('UPDATE users SET is_active = ? WHERE id = ?', [newStatus, req.params.userId]);
    res.json({ success: true, is_active: !!newStatus });
  } catch (err) { res.status(500).json({ error: '服务器错误' }); }
});

module.exports = router;
