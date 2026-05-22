const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { setupWebSocket } = require('./ws');
const apiRoutes = require('./api');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// 静态文件
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/avatars', express.static(path.join(__dirname, '..', 'public', 'avatars')));

// API 路由
app.use('/api', apiRoutes);

// 快捷登录：/?uid=xxx 或 /login/xxx
app.get('/login/:uid', async (req, res) => {
  const { uid } = req.params;
  const { queryOne } = require('./db');
  const user = await queryOne('SELECT id FROM users WHERE id = ?', [uid]);
  if (user) {
    res.cookie('user_id', user.id, { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, path: '/' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// 管理后台
app.use('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// 所有其他页面路由指向 index.html
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// 启动服务
const server = app.listen(PORT, () => {
  console.log(`MiniTalk 已启动: http://localhost:${PORT}`);
  console.log(`管理后台: http://localhost:${PORT}/admin`);
});

// 设置 WebSocket
setupWebSocket(server);
