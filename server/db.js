const path = require('path');
const fs = require('fs');

// Turso 数据库 URL 和 Token（从环境变量读取，本地回退到 SQLite）
const TURSO_DB_URL = process.env.TURSO_DB_URL;
const TURSO_DB_TOKEN = process.env.TURSO_DB_TOKEN;

let db;

if (TURSO_DB_URL && TURSO_DB_TOKEN) {
  // ========== Turso (生产环境) ==========
  const { createClient } = require('@libsql/client');
  db = createClient({
    url: TURSO_DB_URL,
    authToken: TURSO_DB_TOKEN,
  });

  // 由于 Turso 的 execute 返回格式不同，包装统一接口
  const originalPrepare = db.prepare;
  db._tursoMode = true;

  // Turso 兼容包装
  db.prepare = (sql) => {
    return {
      sql,
      run: async (...params) => {
        const result = await db.execute({ sql, args: params });
        return { lastInsertRowid: result.lastInsertRowid };
      },
      get: async (...params) => {
        const result = await db.execute({ sql, args: params });
        return result.rows[0] || null;
      },
      all: async (...params) => {
        const result = await db.execute({ sql, args: params });
        return result.rows;
      },
    };
  };

  // 重写 db.exec 为异步批量
  db._exec = db.exec;
  db.exec = async (sql) => {
    for (const statement of sql.split(';').filter(s => s.trim())) {
      await db.execute(statement);
    }
  };
} else {
  // ========== SQLite (本地开发) ==========
  const Database = require('better-sqlite3');
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  db = new Database(path.join(dataDir, 'minitalk.db'));
  db.pragma('journal_mode = WAL');
}

// 初始化表结构
const schema = `
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
    UNIQUE(user_id, friend_id)
  );

  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS groups_table (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    avatar TEXT DEFAULT '/avatars/group-default.svg',
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    to_id TEXT,
    group_id TEXT,
    type TEXT DEFAULT 'text',
    content TEXT,
    file_path TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`;

// 同步或异步执行建表
if (db._tursoMode) {
  db.exec(schema).catch(err => console.error('DB init error:', err));
} else {
  db.exec(schema);

  // 创建默认管理员（admin / admin123）
  const adminStmt = db.prepare('SELECT id FROM admin_users WHERE username = ?');
  const existing = adminStmt.get('admin');
  if (!existing) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO admin_users (username, password) VALUES (?, ?)').run('admin', hash);
  }
}

// 确保默认头像目录存在
const avatarsDir = path.join(__dirname, '..', 'public', 'avatars');
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

const defaultAvatar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="50" fill="#e0e0e0"/><text x="50" y="55" text-anchor="middle" font-size="40" fill="#999" font-family="Arial">?</text></svg>`;
if (!fs.existsSync(path.join(avatarsDir, 'default.svg')))
  fs.writeFileSync(path.join(avatarsDir, 'default.svg'), defaultAvatar);
if (!fs.existsSync(path.join(avatarsDir, 'group-default.svg')))
  fs.writeFileSync(path.join(avatarsDir, 'group-default.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="16" fill="#e0e0e0"/><text x="50" y="55" text-anchor="middle" font-size="30" fill="#999" font-family="Arial">G</text></svg>`);

// 因为 Turso async vs SQLite sync 不兼容，做个统一的查询辅助函数
async function query(sql, params = []) {
  if (db._tursoMode) {
    const result = await db.execute({ sql, args: params });
    return result.rows;
  } else {
    return db.prepare(sql).all(...params);
  }
}

async function queryOne(sql, params = []) {
  if (db._tursoMode) {
    const result = await db.execute({ sql, args: params });
    return result.rows[0] || null;
  } else {
    return db.prepare(sql).get(...params) || null;
  }
}

async function run(sql, params = []) {
  if (db._tursoMode) {
    const result = await db.execute({ sql, args: params });
    return { lastInsertRowid: result.lastInsertRowid };
  } else {
    return db.prepare(sql).run(...params);
  }
}

module.exports = { db, query, queryOne, run };
