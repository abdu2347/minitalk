const WebSocket = require('ws');
const { query, queryOne, run } = require('./db');

const onlineUsers = new Map();

function setupWebSocket(server) {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    let userId = null;

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);
        const { type, payload } = msg;

        switch (type) {
          case 'auth': {
            userId = payload.userId;
            const user = await queryOne('SELECT id, username, nickname, avatar, bio FROM users WHERE id = ?', [userId]);
            if (user) {
              onlineUsers.set(userId, { ws, userInfo: user });
              await run('UPDATE users SET last_active_at = datetime(\'now\', \'localtime\') WHERE id = ?', [userId]);
              broadcastOnlineUsers();
              notifyFriendsOnline(userId);
            }
            break;
          }

          case 'message': {
            const { toId, groupId, type: msgType, content, filePath } = payload;
            const result = await run(
              'INSERT INTO messages (from_id, to_id, group_id, type, content, file_path) VALUES (?, ?, ?, ?, ?, ?)',
              [userId, toId || null, groupId || null, msgType || 'text', content || null, filePath || null]
            );
            const messageId = result.lastInsertRowid;

            // 获取发送者信息
            const sender = await queryOne('SELECT nickname, avatar FROM users WHERE id = ?', [userId]);

            const msgObj = {
              id: messageId,
              from_id: userId,
              from_nickname: sender?.nickname || '',
              from_avatar: sender?.avatar || '',
              to_id: toId || null,
              group_id: groupId || null,
              type: msgType || 'text',
              content: content || null,
              file_path: filePath || null,
              created_at: new Date().toISOString()
            };

            if (groupId) {
              const members = await query('SELECT user_id FROM group_members WHERE group_id = ?', [groupId]);
              members.forEach(m => {
                const peer = onlineUsers.get(m.user_id);
                if (peer && peer.ws.readyState === WebSocket.OPEN) {
                  peer.ws.send(JSON.stringify({ type: 'message', payload: msgObj }));
                }
              });
            } else if (toId) {
              const peer = onlineUsers.get(toId);
              if (peer && peer.ws.readyState === WebSocket.OPEN) {
                peer.ws.send(JSON.stringify({ type: 'message', payload: msgObj }));
              }
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
              const members = await query('SELECT user_id FROM group_members WHERE group_id = ?', [groupId]);
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
              const fromUser = await queryOne('SELECT id, nickname, avatar FROM users WHERE id = ?', [userId]);
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
        // ignore parse errors and db errors
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
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
  }

  async function notifyFriendsOnline(userId) {
    const friends = await query(
      'SELECT u.id FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ?', [userId]);
    const msg = JSON.stringify({ type: 'friend_online', payload: { userId } });
    friends.forEach(f => {
      const peer = onlineUsers.get(f.id);
      if (peer && peer.ws.readyState === WebSocket.OPEN) peer.ws.send(msg);
    });
  }

  global.getOnlineUsers = () => Array.from(onlineUsers.keys());
}

module.exports = { setupWebSocket, onlineUsers };
