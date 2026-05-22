const WebSocket = require('ws');
const db = require('./db');

// 存储在线用户：userId -> { ws, userInfo }
const onlineUsers = new Map();

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    let userId = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        const { type, payload } = msg;

        switch (type) {
          case 'auth': {
            userId = payload.userId;
            const user = db.prepare('SELECT id, username, nickname, avatar, bio FROM users WHERE id = ?').get(userId);
            if (user) {
              onlineUsers.set(userId, { ws, userInfo: user });
              // 更新最后活跃时间
              db.prepare('UPDATE users SET last_active_at = datetime(\'now\', \'localtime\') WHERE id = ?').run(userId);
              // 广播在线状态
              broadcastOnlineUsers();
              // 通知好友上线
              notifyFriendsOnline(userId);
            }
            break;
          }

          case 'message': {
            const { toId, groupId, type: msgType, content, filePath } = payload;
            // 保存消息到数据库
            const stmt = db.prepare(
              'INSERT INTO messages (from_id, to_id, group_id, type, content, file_path) VALUES (?, ?, ?, ?, ?, ?)'
            );
            const result = stmt.run(userId, toId || null, groupId || null, msgType || 'text', content || null, filePath || null);
            const messageId = result.lastInsertRowid;

            // 构造消息对象
            const msgObj = {
              id: messageId,
              from_id: userId,
              to_id: toId || null,
              group_id: groupId || null,
              type: msgType || 'text',
              content: content || null,
              file_path: filePath || null,
              created_at: new Date().toISOString()
            };

            if (groupId) {
              // 发送到群组所有成员
              const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId);
              members.forEach(m => {
                const peer = onlineUsers.get(m.user_id);
                if (peer && peer.ws.readyState === WebSocket.OPEN) {
                  peer.ws.send(JSON.stringify({ type: 'message', payload: msgObj }));
                }
              });
            } else if (toId) {
              // 发送私聊
              const peer = onlineUsers.get(toId);
              if (peer && peer.ws.readyState === WebSocket.OPEN) {
                peer.ws.send(JSON.stringify({ type: 'message', payload: msgObj }));
              }
              // 也发给发送者自己
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'message', payload: msgObj }));
              }
            }
            break;
          }

          case 'typing': {
            const { toId, groupId } = payload;
            if (toId) {
              const peer = onlineUsers.get(toId);
              if (peer && peer.ws.readyState === WebSocket.OPEN) {
                peer.ws.send(JSON.stringify({ type: 'typing', payload: { userId, groupId: null } }));
              }
            }
            if (groupId) {
              const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId);
              members.forEach(m => {
                if (m.user_id !== userId) {
                  const peer = onlineUsers.get(m.user_id);
                  if (peer && peer.ws.readyState === WebSocket.OPEN) {
                    peer.ws.send(JSON.stringify({ type: 'typing', payload: { userId, groupId } }));
                  }
                }
              });
            }
            break;
          }

          case 'friend_request': {
            const { toId } = payload;
            const peer = onlineUsers.get(toId);
            if (peer && peer.ws.readyState === WebSocket.OPEN) {
              const fromUser = db.prepare('SELECT id, nickname, avatar FROM users WHERE id = ?').get(userId);
              peer.ws.send(JSON.stringify({ type: 'friend_request', payload: fromUser }));
            }
            break;
          }

          case 'friend_request_response': {
            const { fromId, accepted } = payload;
            const peer = onlineUsers.get(fromId);
            if (peer && peer.ws.readyState === WebSocket.OPEN) {
              peer.ws.send(JSON.stringify({ type: 'friend_request_response', payload: { userId, accepted } }));
            }
            break;
          }
        }
      } catch (e) {
        // ignore parse errors
      }
    });

    ws.on('close', () => {
      if (userId) {
        onlineUsers.delete(userId);
        broadcastOnlineUsers();
      }
    });

    ws.on('error', () => {
      if (userId) {
        onlineUsers.delete(userId);
        broadcastOnlineUsers();
      }
    });
  });

  function broadcastOnlineUsers() {
    const users = Array.from(onlineUsers.values()).map(u => u.userInfo);
    const msg = JSON.stringify({ type: 'online_users', payload: users });
    onlineUsers.forEach(({ ws }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    });
  }

  function notifyFriendsOnline(userId) {
    const friends = db.prepare(`
      SELECT u.id, u.nickname, u.avatar FROM friends f
      JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ?
    `).all(userId);
    // 通知好友该用户上线
    const msg = JSON.stringify({ type: 'friend_online', payload: { userId } });
    friends.forEach(f => {
      const peer = onlineUsers.get(f.id);
      if (peer && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(msg);
      }
    });
  }

  // 获取在线用户列表（给 REST API 用）
  global.getOnlineUsers = () => Array.from(onlineUsers.keys());
}

module.exports = { setupWebSocket, onlineUsers };
