// ========== 全局状态 ==========
let currentUser = null;
let ws = null;
let chats = []; // { type: 'private'|'group', id, name, avatar, lastMsg, unread, messages[] }
let activeChat = null; // { type, id, name, avatar }
let currentFriendRequests = [];
let mediaRecorder = null;
let audioChunks = [];
let recordingTimer = null;
let recordingSeconds = 0;

// WebSocket 重连
let wsReconnectTimer = null;

// ========== 工具函数 ==========
function $(id) { return document.getElementById(id); }

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $(id).classList.add('active');
}

function showModal(html) {
  $('activeModal').innerHTML = html;
  $('modalOverlay').classList.remove('hidden');
}

function closeModal(e) {
  if (!e || e.target === $('modalOverlay')) {
    $('modalOverlay').classList.add('hidden');
  }
}

function formatTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  if (isToday) return `${hours}:${mins}`;
  return `${d.getMonth()+1}/${d.getDate()} ${hours}:${mins}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ========== 快捷登录（URL 参数）==========
function getQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

async function handleQuickLogin() {
  const uid = getQueryParam('uid');
  const pwd = getQueryParam('pwd') || 'minitalk123';
  if (!uid) return;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uid, password: pwd })
    });
    const data = await res.json();
    if (data.success) {
      currentUser = data.user;
      initApp();
      // 清除 URL 参数
      window.history.replaceState({}, '', window.location.pathname);
    }
  } catch (err) {}
}

// 页面加载时检测快捷登录
(async function() {
  const uid = getQueryParam('uid');
  if (uid) {
    // 隐藏登录表单，显示快捷按钮
    document.querySelectorAll('.auth-tabs').forEach(e => e.classList.add('hidden'));
    document.querySelectorAll('.auth-form').forEach(e => e.classList.add('hidden'));
    document.getElementById('quickLoginArea').classList.remove('hidden');
    document.getElementById('loginHint').textContent = `欢迎，${uid}！`;
  }
})();

// ========== Auth 切换 ==========
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
  if (tab === 'login') {
    document.querySelectorAll('.auth-tab')[0].classList.add('active');
    $('loginForm').classList.add('active');
  } else {
    document.querySelectorAll('.auth-tab')[1].classList.add('active');
    $('registerForm').classList.add('active');
  }
  $('loginError').textContent = '';
  $('regError').textContent = '';
}

// ========== 登录/注册 ==========
async function handleLogin(e) {
  e.preventDefault();
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value.trim();
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.success) {
      currentUser = data.user;
      initApp();
    } else {
      $('loginError').textContent = data.error;
    }
  } catch (err) {
    $('loginError').textContent = '网络错误，请检查服务器';
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const username = $('regUsername').value.trim();
  const nickname = $('regNickname').value.trim();
  const id = $('regId').value.trim();
  const password = $('regPassword').value;
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, nickname, id: id || undefined })
    });
    const data = await res.json();
    if (data.success) {
      $('regError').textContent = '注册成功！请登录';
      $('regError').style.color = 'var(--green)';
      switchAuthTab('login');
      $('loginUsername').value = username;
    } else {
      $('regError').textContent = data.error;
    }
  } catch (err) {
    $('regError').textContent = '网络错误';
  }
}

async function handleLogout() {
  await fetch('/api/logout', { method: 'POST' });
  if (ws) { ws.close(); ws = null; }
  currentUser = null;
  activeChat = null;
  chats = [];
  showPage('loginPage');
}

// ========== 初始化应用 ==========
async function initApp() {
  showPage('mainPage');
  updateUserInfo();
  await loadFriends();
  await loadGroups();
  await loadFriendRequests();
  connectWebSocket();
  renderChatList();
}

function updateUserInfo() {
  if (!currentUser) return;
  $('myAvatar').src = currentUser.avatar || '/avatars/default.svg';
  $('myNickname').textContent = currentUser.nickname;
}

// ========== WebSocket ==========
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', payload: { userId: currentUser.id } }));
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleWsMessage(msg);
    } catch (err) {}
  };

  ws.onclose = () => {
    // 自动重连
    wsReconnectTimer = setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => {};
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'message':
      receiveMessage(msg.payload);
      break;
    case 'typing':
      handleTyping(msg.payload);
      break;
    case 'friend_request':
      showFriendRequestNotification(msg.payload);
      break;
    case 'friend_request_response':
      handleFriendRequestResponse(msg.payload);
      break;
    case 'online_users':
      updateOnlineStatus(msg.payload);
      break;
    case 'friend_online':
      handleFriendOnline(msg.payload);
      break;
  }
}

// ========== 消息接收 ==========
function receiveMessage(msg) {
  const { from_id, to_id, group_id } = msg;
  let chatKey, chatType;

  if (group_id) {
    chatKey = 'g_' + group_id;
    chatType = 'group';
  } else if (from_id === currentUser.id) {
    chatKey = 'p_' + to_id;
    chatType = 'private';
  } else {
    chatKey = 'p_' + from_id;
    chatType = 'private';
  }

  let chat = chats.find(c => c.chatKey === chatKey);
  if (chat) {
    chat.messages.push(msg);
    chat.lastMsg = msg;
  } else {
    // 新聊天，从数据加载
    loadChatMessages(chatType, chatType === 'group' ? group_id : (from_id === currentUser.id ? to_id : from_id));
    return;
  }

  // 如果当前在聊这个，追加到视图
  if (activeChat && activeChat.chatKey === chatKey) {
    appendMessageToView(msg);
  }

  scrollToBottom();
  renderChatList();
}

// ========== 聊天相关 ==========
async function loadFriends() {
  const res = await fetch('/api/friends');
  const data = await res.json();
  data.friends.forEach(f => {
    const chatKey = 'p_' + f.id;
    if (!chats.find(c => c.chatKey === chatKey)) {
      chats.push({
        chatKey,
        type: 'private',
        id: f.id,
        name: f.nickname,
        avatar: f.avatar,
        subtitle: f.bio || '',
        lastMsg: null,
        messages: [],
        unread: 0,
        online: false
      });
    }
  });
}

async function loadGroups() {
  const res = await fetch('/api/groups');
  const data = await res.json();
  data.groups.forEach(g => {
    const chatKey = 'g_' + g.id;
    if (!chats.find(c => c.chatKey === chatKey)) {
      chats.push({
        chatKey,
        type: 'group',
        id: g.id,
        name: g.name,
        avatar: g.avatar,
        subtitle: g.member_count + ' 位成员',
        lastMsg: null,
        messages: [],
        unread: 0
      });
    }
  });
}

function renderChatList() {
  const list = $('chatList');
  // 排序：有最后消息的按时间排，否则按名称
  const sorted = [...chats].sort((a, b) => {
    if (a.lastMsg && b.lastMsg) return new Date(b.lastMsg.created_at) - new Date(a.lastMsg.created_at);
    if (a.lastMsg) return -1;
    if (b.lastMsg) return 1;
    return a.name.localeCompare(b.name);
  });

  list.innerHTML = sorted.map(c => {
    const isActive = activeChat && activeChat.chatKey === c.chatKey;
    const lastText = c.lastMsg
      ? (c.lastMsg.type === 'text' ? c.lastMsg.content
        : c.lastMsg.type === 'image' ? '📷 图片'
        : c.lastMsg.type === 'voice' ? '🎤 语音'
        : c.lastMsg.content)
      : '';
    const timeStr = c.lastMsg ? formatTime(c.lastMsg.created_at) : '';
    const unreadBadge = c.unread > 0 ? `<span class="unread-badge">${c.unread}</span>` : '';
    const onlineDot = c.online ? '<span class="status-dot status-online"></span>' : '';

    return `<div class="chat-item ${isActive ? 'active' : ''}" onclick="openChat('${c.chatKey}')">
      <div style="position:relative">
        <img src="${c.avatar || '/avatars/default.svg'}" class="avatar-sm" onerror="this.src='/avatars/default.svg'">
        ${onlineDot}
      </div>
      <div class="chat-item-info">
        <div class="chat-item-name">${escapeHtml(c.name)} ${unreadBadge}</div>
        <div class="chat-item-preview">${escapeHtml(lastText)}</div>
      </div>
      <div class="chat-item-time">${timeStr}</div>
    </div>`;
  }).join('');
}

async function openChat(chatKey) {
  // 清除未读
  const chat = chats.find(c => c.chatKey === chatKey);
  if (!chat) return;
  chat.unread = 0;

  activeChat = chat;
  const type = chat.type;
  const id = chat.id;

  $('emptyChat').classList.add('hidden');
  $('chatView').classList.remove('hidden');

  $('chatAvatar').src = chat.avatar || '/avatars/default.svg';
  $('chatTitle').textContent = chat.name;
  $('chatSubtitle').textContent = type === 'group' ? '群聊' : (chat.subtitle || '好友');

  // 显示/隐藏群信息按钮
  $('chatInfoBtn').style.display = type === 'group' ? 'flex' : 'none';
  $('chatInfoBtn').dataset.groupId = id;

  // 加载消息
  await loadChatMessages(type, id, chat.messages.length > 0);
  renderChatList();
  $('messageInput').focus();
}

async function loadChatMessages(type, id, hasLocal) {
  const chat = chats.find(c => c.type === type && c.id === id);
  if (!chat) return;

  if (hasLocal) {
    renderMessages(chat.messages);
    return;
  }

  try {
    const res = await fetch(`/api/messages/${type}/${id}?limit=50`);
    const data = await res.json();
    chat.messages = data.messages || [];
    renderMessages(chat.messages);
    scrollToBottom();
  } catch (err) {}
}

function renderMessages(messages) {
  const container = $('messages');
  if (!messages || messages.length === 0) {
    container.innerHTML = `<div class="empty-chat" style="padding:40px"><p>暂无消息，打个招呼吧 👋</p></div>`;
    return;
  }

  container.innerHTML = messages.map((m, i) => {
    const isSelf = m.from_id === currentUser.id;
    const showSender = !isSelf && activeChat && activeChat.type === 'group';

    let contentHtml = '';
    if (m.type === 'text') {
      // 检查是否为纯 emoji
      const isOnlyEmoji = /^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{200D}]+$/u.test(m.content.trim());
      if (isOnlyEmoji && m.content.trim().length <= 4) {
        contentHtml = `<span class="msg-emoji">${escapeHtml(m.content)}</span>`;
      } else {
        contentHtml = `<span>${escapeHtml(m.content)}</span>`;
      }
    } else if (m.type === 'image') {
      contentHtml = `<img src="${m.file_path}" class="msg-image" onclick="window.open('${m.file_path}')" alt="图片">`;
    } else if (m.type === 'voice') {
      contentHtml = `<audio controls src="${m.file_path}"></audio>`;
    }

    return `<div class="message ${isSelf ? 'self' : 'other'}">
      ${showSender ? `<span class="msg-sender">${escapeHtml(m.from_nickname || '')}</span>` : ''}
      ${contentHtml}
      <div class="msg-time">${formatTime(m.created_at)}</div>
    </div>`;
  }).join('');
}

function appendMessageToView(msg) {
  const container = $('messages');
  // 移除empty提示
  const empty = container.querySelector('.empty-chat');
  if (empty) empty.remove();

  const isSelf = msg.from_id === currentUser.id;
  const showSender = !isSelf && activeChat && activeChat.type === 'group';

  let contentHtml = '';
  if (msg.type === 'text') {
    const isOnlyEmoji = /^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{200D}]+$/u.test(msg.content.trim());
    if (isOnlyEmoji && msg.content.trim().length <= 4) {
      contentHtml = `<span class="msg-emoji">${escapeHtml(msg.content)}</span>`;
    } else {
      contentHtml = `<span>${escapeHtml(msg.content)}</span>`;
    }
  } else if (msg.type === 'image') {
    contentHtml = `<img src="${msg.file_path}" class="msg-image" onclick="window.open('${msg.file_path}')" alt="图片">`;
  } else if (msg.type === 'voice') {
    contentHtml = `<audio controls src="${msg.file_path}"></audio>`;
  }

  const div = document.createElement('div');
  div.className = `message ${isSelf ? 'self' : 'other'}`;
  div.innerHTML = `
    ${showSender ? `<span class="msg-sender">${escapeHtml(msg.from_nickname || '')}</span>` : ''}
    ${contentHtml}
    <div class="msg-time">${formatTime(msg.created_at)}</div>
  `;
  container.appendChild(div);
}

// ========== 发送消息 ==========
function handleInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    return;
  }
  // 发送 typing 通知
  if (activeChat && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'typing',
      payload: {
        toId: activeChat.type === 'private' ? activeChat.id : null,
        groupId: activeChat.type === 'group' ? activeChat.id : null
      }
    }));
  }
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

async function sendMessage() {
  const input = $('messageInput');
  const text = input.value.trim();
  if (!text || !activeChat) return;

  input.value = '';
  input.style.height = 'auto';

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'message',
      payload: {
        toId: activeChat.type === 'private' ? activeChat.id : null,
        groupId: activeChat.type === 'group' ? activeChat.id : null,
        type: 'text',
        content: text
      }
    }));
  }
}

async function sendImage(e) {
  const file = e.target.files[0];
  if (!file || !activeChat) return;
  e.target.value = '';

  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/api/upload/image', { method: 'POST', body: formData });
  const data = await res.json();
  if (data.success && ws) {
    ws.send(JSON.stringify({
      type: 'message',
      payload: {
        toId: activeChat.type === 'private' ? activeChat.id : null,
        groupId: activeChat.type === 'group' ? activeChat.id : null,
        type: 'image',
        filePath: data.url
      }
    }));
  }
}

// ========== 表情 ==========
function openEmojiPicker() {
  const picker = $('emojiPicker');
  if (!picker.classList.contains('hidden')) {
    picker.classList.add('hidden');
    return;
  }

  if ($('emojiGrid').children.length === 0) {
    const commonEmojis = '😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩😘😗😚😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬🤥😌😔😪🤤😴😷🤒🤕🤢🤮🤧🥵🥶🥴😵🤯🤠🥳🥸😎🤓🧐😕😟🙁😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬😈👿💀☠️💩🤡👹👺👻👽🤖🎃😺😸😹😻😼😽🙀😿😾❤️🧡💛💚💙💜🖤🤍🤎💔❤️‍🔥❤️‍🩹❣️💕💞💓💗💖💘💝💟👍👎👌✌️🤞🤟🤘🤙👋🤚🖐️✋🖖🫶👏🙌🤝💪✍️🙏';
    const grid = $('emojiGrid');
    for (const emoji of commonEmojis) {
      const btn = document.createElement('button');
      btn.className = 'emoji-item';
      btn.textContent = emoji;
      btn.onclick = () => {
        const input = $('messageInput');
        input.value += emoji;
        input.focus();
        picker.classList.add('hidden');
      };
      grid.appendChild(btn);
    }
  }

  picker.classList.remove('hidden');
  // 点击其他地方关闭
  setTimeout(() => {
    document.addEventListener('click', closeEmojiPicker, { once: true });
  }, 100);
}

function closeEmojiPicker(e) {
  const picker = $('emojiPicker');
  if (!picker.contains(e.target) && e.target !== document.querySelector('.tool-btn')) {
    picker.classList.add('hidden');
  } else {
    document.addEventListener('click', closeEmojiPicker, { once: true });
  }
}

// ========== 语音录制 ==========
function toggleVoiceRecord() {
  $('voiceRecordModal').classList.remove('hidden');
  $('recordBtn').disabled = false;
  $('stopBtn').disabled = true;
  $('sendVoiceBtn').disabled = true;
  $('voiceTimer').textContent = '00:00';
  audioChunks = [];
  recordingSeconds = 0;
}

function closeVoiceRecord(e) {
  if (!e || e.target === $('voiceRecordModal')) {
    $('voiceRecordModal').classList.add('hidden');
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
  }
}

async function startRecording() {
  if (!navigator.mediaDevices) {
    alert('您的浏览器不支持语音录制');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
      $('sendVoiceBtn').disabled = false;
    };

    mediaRecorder.start();
    $('recordBtn').disabled = true;
    $('stopBtn').disabled = false;

    recordingSeconds = 0;
    recordingTimer = setInterval(() => {
      recordingSeconds++;
      const m = String(Math.floor(recordingSeconds / 60)).padStart(2, '0');
      const s = String(recordingSeconds % 60).padStart(2, '0');
      $('voiceTimer').textContent = `${m}:${s}`;
    }, 1000);

  } catch (err) {
    alert('无法访问麦克风');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  $('recordBtn').disabled = true;
  $('stopBtn').disabled = true;
}

async function sendVoiceRecording() {
  if (audioChunks.length === 0) return;
  const blob = new Blob(audioChunks, { type: 'audio/webm' });
  const formData = new FormData();
  formData.append('file', blob, 'voice.webm');

  try {
    const res = await fetch('/api/upload/voice', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.success && ws) {
      ws.send(JSON.stringify({
        type: 'message',
        payload: {
          toId: activeChat.type === 'private' ? activeChat.id : null,
          groupId: activeChat.type === 'group' ? activeChat.id : null,
          type: 'voice',
          filePath: data.url
        }
      }));
    }
  } catch (err) {}

  closeVoiceRecord(null);
}

// ========== 聊天搜索过滤 ==========
function filterChats(query) {
  const items = document.querySelectorAll('.chat-item');
  items.forEach(item => {
    const name = item.querySelector('.chat-item-name')?.textContent || '';
    item.style.display = name.includes(query) || !query ? 'flex' : 'none';
  });
}

// ========== 好友管理 ==========
async function loadFriendRequests() {
  try {
    const res = await fetch('/api/friend-requests');
    const data = await res.json();
    currentFriendRequests = data.requests || [];
  } catch (err) {}
}

function showAddFriend() {
  let listHtml = '';
  if (currentFriendRequests.length > 0) {
    listHtml = currentFriendRequests.filter(r => r.status === 'pending').map(r => `
      <div class="request-item">
        <img src="${r.avatar || '/avatars/default.svg'}" class="avatar-sm" onerror="this.src='/avatars/default.svg'">
        <div>
          <div style="font-weight:600">${escapeHtml(r.nickname)}</div>
          <div style="font-size:12px;color:var(--text-secondary)">ID: ${escapeHtml(r.from_id)}</div>
        </div>
        <div class="request-actions">
          <button class="btn-sm btn-accept" onclick="handleFriendRequest(${r.id}, 'accept')">接受</button>
          <button class="btn-sm btn-reject" onclick="handleFriendRequest(${r.id}, 'reject')">拒绝</button>
        </div>
      </div>
    `).join('') || '<p style="color:var(--text-secondary);text-align:center">暂无好友请求</p>';
  }

  showModal(`
    <button class="modal-close" onclick="closeModal()">✕</button>
    <h3>添加好友</h3>

    <div class="form-group">
      <label>搜索用户（输入ID或昵称）</label>
      <input type="text" id="friendSearchInput" placeholder="输入用户ID或昵称..." oninput="searchUsers(this.value)">
    </div>
    <div id="searchResults"></div>

    <hr style="margin:16px 0;border:none;border-top:1px solid var(--border)">

    <h4 style="font-size:14px;margin-bottom:8px;">好友请求</h4>
    <div id="friendRequestList">${listHtml}</div>
  `);
}

async function searchUsers(q) {
  if (!q || q.length < 1) {
    $('searchResults').innerHTML = '';
    return;
  }
  try {
    const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    $('searchResults').innerHTML = data.users.map(u => `
      <div class="search-result-item">
        <img src="${u.avatar || '/avatars/default.svg'}" class="avatar-sm" onerror="this.src='/avatars/default.svg'">
        <div style="flex:1">
          <div style="font-weight:600">${escapeHtml(u.nickname)}</div>
          <div style="font-size:12px;color:var(--text-secondary)">ID: ${escapeHtml(u.id)}${u.bio ? ' · ' + escapeHtml(u.bio) : ''}</div>
        </div>
        <button class="btn-sm" onclick="sendFriendRequest('${u.id}')">加好友</button>
      </div>
    `).join('');
  } catch (err) {}
}

async function sendFriendRequest(targetId) {
  try {
    const res = await fetch('/api/friend-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId })
    });
    const data = await res.json();
    if (data.success) {
      alert('好友请求已发送！');
      // 通过 WebSocket 通知对方
      if (ws) {
        ws.send(JSON.stringify({ type: 'friend_request', payload: { toId: targetId } }));
      }
    } else {
      alert(data.error);
    }
  } catch (err) {
    alert('发送失败');
  }
}

async function handleFriendRequest(requestId, action) {
  try {
    const res = await fetch(`/api/friend-request/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId })
    });
    const data = await res.json();
    if (data.success) {
      alert(action === 'accept' ? '已添加好友！' : '已拒绝');
      // 重新加载好友列表
      chats = [];
      await loadFriends();
      renderChatList();
      showAddFriend();
    }
  } catch (err) {}
}

function showFriendRequestNotification(payload) {
  // 已打开模态框则刷新
  if (!$('modalOverlay').classList.contains('hidden') && $('activeModal').querySelector('h3')?.textContent === '添加好友') {
    loadFriendRequests().then(() => showAddFriend());
  } else {
    alert(`${payload.nickname} 请求添加你为好友`);
  }
}

function handleFriendRequestResponse(payload) {
  if (payload.accepted) {
    alert('好友请求已接受！');
    chats = [];
    loadFriends();
    renderChatList();
  } else {
    alert('好友请求被拒绝');
  }
}

// ========== 创建群组 ==========
async function showCreateGroup() {
  // 加载好友列表供选择
  const res = await fetch('/api/friends');
  const data = await res.json();
  const friends = data.friends || [];

  showModal(`
    <button class="modal-close" onclick="closeModal()">✕</button>
    <h3>创建群组</h3>
    <div class="form-group">
      <label>群名称</label>
      <input type="text" id="groupNameInput" placeholder="输入群组名称">
    </div>
    <h4 style="font-size:14px;margin-bottom:8px;">选择成员</h4>
    <div id="groupMemberList">
      ${friends.map(f => `
        <div class="user-list-item">
          <input type="checkbox" value="${f.id}" id="gm_${f.id}">
          <img src="${f.avatar || '/avatars/default.svg'}" class="avatar-sm" onerror="this.src='/avatars/default.svg'">
          <label for="gm_${f.id}" style="flex:1;cursor:pointer">${escapeHtml(f.nickname)}</label>
        </div>
      `).join('') || '<p style="color:var(--text-secondary)">还没有好友，先添加好友吧</p>'}
    </div>
    <button class="btn-primary" onclick="createGroup()">创建群组</button>
  `);
}

async function createGroup() {
  const name = $('groupNameInput').value.trim();
  if (!name) { alert('请输入群名称'); return; }
  const checkboxes = document.querySelectorAll('#groupMemberList input[type="checkbox"]:checked');
  const memberIds = Array.from(checkboxes).map(cb => cb.value);

  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, memberIds })
    });
    const data = await res.json();
    if (data.success) {
      alert('群组创建成功！');
      closeModal();
      chats = [];
      await loadFriends();
      await loadGroups();
      renderChatList();
      // 打开新群
      openChat('g_' + data.groupId);
    } else {
      alert(data.error);
    }
  } catch (err) {
    alert('创建失败');
  }
}

// ========== 群详情 ==========
async function showChatInfo() {
  const groupId = $('chatInfoBtn').dataset.groupId;
  if (!groupId) return;
  try {
    const res = await fetch(`/api/groups/${groupId}`);
    const data = await res.json();
    if (!data.group) return;

    showModal(`
      <button class="modal-close" onclick="closeModal()">✕</button>
      <h3>${escapeHtml(data.group.name)}</h3>
      <div style="text-align:center;margin:12px 0">
        <img src="${data.group.avatar || '/avatars/group-default.svg'}" class="avatar-lg" onerror="this.src='/avatars/group-default.svg'">
        <p style="color:var(--text-secondary);font-size:13px;margin-top:4px">${data.members.length} 位成员</p>
      </div>
      <hr style="margin:12px 0;border:none;border-top:1px solid var(--border)">
      <h4 style="font-size:14px;margin-bottom:8px;">成员列表</h4>
      ${data.members.map(m => `
        <div class="request-item">
          <img src="${m.avatar || '/avatars/default.svg'}" class="avatar-sm" onerror="this.src='/avatars/default.svg'">
          <div>
            <div style="font-weight:600">${escapeHtml(m.nickname)} ${m.role === 'owner' ? '👑' : ''}</div>
            <div style="font-size:12px;color:var(--text-secondary)">${m.role === 'owner' ? '群主' : m.role === 'admin' ? '管理员' : '成员'}</div>
          </div>
        </div>
      `).join('')}
    `);
  } catch (err) {}
}

// ========== 个人资料 ==========
function showUserProfile() {
  showModal(`
    <button class="modal-close" onclick="closeModal()">✕</button>
    <h3>个人资料</h3>
    <div style="text-align:center;margin:12px 0">
      <img src="${currentUser.avatar || '/avatars/default.svg'}" class="avatar-lg" id="profileAvatar" onerror="this.src='/avatars/default.svg'">
      <div style="margin-top:8px">
        <button class="btn-sm" onclick="document.getElementById('avatarInput').click()">更换头像</button>
        <input type="file" id="avatarInput" accept="image/*" hidden onchange="uploadAvatar(event)">
      </div>
    </div>
    <div class="form-group">
      <label>ID</label>
      <input type="text" value="${currentUser.id}" readonly style="background:#f5f5f5">
    </div>
    <div class="form-group">
      <label>昵称</label>
      <input type="text" id="profileNickname" value="${escapeHtml(currentUser.nickname)}">
    </div>
    <div class="form-group">
      <label>个性签名</label>
      <input type="text" id="profileBio" value="${escapeHtml(currentUser.bio || '')}" placeholder="写一句话介绍自己">
    </div>
    <button class="btn-primary" onclick="updateProfile()">保存</button>
  `);
}

async function uploadAvatar(e) {
  const file = e.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('avatar', file);
  const res = await fetch('/api/avatar', { method: 'POST', body: formData });
  const data = await res.json();
  if (data.success) {
    currentUser.avatar = data.avatar;
    document.querySelectorAll(`img[src="${$('profileAvatar').src}"]`).forEach(img => img.src = data.avatar);
    $('profileAvatar').src = data.avatar;
    updateUserInfo();
    renderChatList();
  }
}

async function updateProfile() {
  const nickname = $('profileNickname').value.trim();
  const bio = $('profileBio').value.trim();
  if (!nickname) { alert('昵称不能为空'); return; }
  const res = await fetch('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, bio })
  });
  const data = await res.json();
  if (data.success) {
    currentUser.nickname = nickname;
    currentUser.bio = bio;
    updateUserInfo();
    if (activeChat && activeChat.type === 'private') {
      $('chatTitle').textContent = nickname;
    }
    renderChatList();
    closeModal();
  }
}

// ========== 滚动到底部 ==========
function scrollToBottom() {
  const container = $('messages');
  setTimeout(() => { container.scrollTop = container.scrollHeight; }, 50);
}

// ========== 打字指示 ==========
let typingTimeout = null;
function handleTyping(payload) {
  const indicator = $('typingIndicator');
  if (activeChat) {
    const isCurrentChat = (payload.groupId && activeChat.type === 'group' && payload.groupId === activeChat.id) ||
      (!payload.groupId && activeChat.type === 'private' && payload.userId === activeChat.id);
    if (isCurrentChat) {
      indicator.textContent = '对方正在输入...';
      if (typingTimeout) clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => { indicator.textContent = ''; }, 3000);
    }
  }
}

// ========== 在线状态更新 ==========
function updateOnlineStatus(users) {
  const onlineIds = users.map(u => u.id);
  chats.forEach(c => {
    if (c.type === 'private') {
      c.online = onlineIds.includes(c.id);
    }
  });
  renderChatList();
}

function handleFriendOnline(payload) {
  const chat = chats.find(c => c.type === 'private' && c.id === payload.userId);
  if (chat) {
    chat.online = true;
    renderChatList();
  }
}

// ==========