const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { setupWebSocket } = require('./ws');
const apiRoutes = require('./api');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(express.json());
app.use(cookieParser());

// 静态文件
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/avatars', express.static(path.join(__dirname, '..', 'public', 'avatars')));

// API 路由
app.use('/api', apiRoutes);

// 管理后台
app.use('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// 所有其他页面路由指向 index.html（需用正则避免 Express 5 '*' 报错）
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
