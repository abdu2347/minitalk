const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'minitalk.db');

// 确保 data 目录存在
const fs = require('fs');
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

// 启用 WAL 模式以提升并发性能
db.pragma('journal_mode = WAL');

// 建表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    nickname TEXT NOT NULL,
    avatar TEXT DEFAULT '/avatars/default.svg',
    bio TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    last_active_at TEXT DEFAULT (datetime('now', 'localtime')),
    login_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(user_id, friend_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (friend_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (from_id) REFERENCES users(id),
    FOREIGN KEY (to_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    avatar TEXT DEFAULT '/avatars/group-default.svg',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES groups(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT,
    group_id TEXT,
    type TEXT DEFAULT 'text',
    content TEXT,
    file_path TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (from_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

// 创建默认管理员（admin / admin123）
const adminStmt = db.prepare('SELECT id FROM admin_users WHERE username = ?');
const existing = adminStmt.get('admin');
if (!existing) {
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO admin_users (username, password) VALUES (?, ?)').run('admin', hash);
}

// 创建默认头像目录
const avatarsDir = path.join(__dirname, '..', 'public', 'avatars');
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

// 写入默认 SVG 头像
const defaultAvatar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="50" fill="#e0e0e0"/><text x="50" y="55" text-anchor="middle" font-size="40" fill="#999" font-family="Arial">?</text></svg>`;
fs.writeFileSync(path.join(avatarsDir, 'default.svg'), defaultAvatar);

const groupDefaultAvatar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="16" fill="#e0e0e0"/><text x="50" y="55" text-anchor="middle" font-size="30" fill="#999" font-family="Arial">G</text></svg>`;
fs.writeFileSync(path.join(avatarsDir, 'group-default.svg'), groupDefaultAvatar);

module.exports = db;
