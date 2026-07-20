/*
 * MAPCG Multiplayer Server
 * ------------------------------------------------------------
 * Central authoritative Socket.IO backend for browser-only MAPCG editor multiplayer.
 * State is intentionally in-memory only: when the host leaves, the room is destroyed.
 */
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 200);
const MAX_PLAYERS_PER_ROOM = Number(process.env.MAX_PLAYERS_PER_ROOM || 16);
const MAX_CHAT_HISTORY = 80;
const MAX_CHAT_LEN = 350;
const ROOM_IDLE_CLOSE_MS = 10_000; // host disconnect grace period

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 100 * 1024 * 1024,
  pingInterval: 25000,
  pingTimeout: 30000,
  perMessageDeflate: {
    threshold: 2048,
    zlibDeflateOptions: { level: 4 }
  }
});

/** @type {Map<string, Room>} */
const rooms = new Map();
const socketToRoom = new Map();

function now() { return Date.now(); }
function rid() { return Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36).slice(-5); }
function cleanText(v, max = 80) {
  return String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) || 'Unnamed';
}
function publicRoom(room) {
  return {
    id: room.id,
    name: room.name,
    description: room.description,
    projectName: room.projectName,
    hostName: room.hostName,
    playerCount: room.players.size,
    maxPlayers: room.maxPlayers,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    revision: room.revision,
    permissions: room.permissions
  };
}
function publicPlayer(player) {
  return {
    id: player.id,
    nickname: player.nickname,
    role: player.role,
    status: player.status || 'online',
    ping: player.ping ?? 0,
    joinedAt: player.joinedAt,
    color: player.color
  };
}
function broadcastRoomList() {
  const list = [...rooms.values()].map(publicRoom).sort((a, b) => b.createdAt - a.createdAt);
  io.emit('mp:rooms', list);
}
function emitPlayers(room) {
  io.to(room.id).emit('mp:players', [...room.players.values()].map(publicPlayer));
}
function roomOfSocket(socket) {
  const roomId = socketToRoom.get(socket.id);
  return roomId ? rooms.get(roomId) : null;
}
function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 78%, 62%)`;
}
function hasEditPermission(room, socketId) {
  const p = room.players.get(socketId);
  if (!p) return false;
  if (p.role === 'admin') return true;
  return !!room.permissions?.guestsCanBuild;
}
function closeRoom(room, reason = 'Host left the server') {
  if (!room || !rooms.has(room.id)) return;
  io.to(room.id).emit('mp:room_closed', { roomId: room.id, reason });
  for (const player of room.players.values()) {
    socketToRoom.delete(player.id);
    const s = io.sockets.sockets.get(player.id);
    if (s) s.leave(room.id);
  }
  rooms.delete(room.id);
  broadcastRoomList();
}

app.get('/', (_, res) => {
  res.type('text/plain').send('MAPCG Multiplayer Server is running. Use Socket.IO from MAPCG client.');
});
app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size, time: now() }));
app.get('/rooms', (_, res) => res.json([...rooms.values()].map(publicRoom)));

io.on('connection', socket => {
  socket.emit('mp:hello', { id: socket.id, time: now(), rooms: [...rooms.values()].map(publicRoom) });

  socket.on('mp:list_rooms', cb => {
    const list = [...rooms.values()].map(publicRoom).sort((a, b) => b.createdAt - a.createdAt);
    if (typeof cb === 'function') cb({ ok: true, rooms: list });
    else socket.emit('mp:rooms', list);
  });

  socket.on('mp:create_room', (payload = {}, cb) => {
    try {
      if (rooms.size >= MAX_ROOMS) throw new Error('Too many active rooms on this server.');
      const nickname = cleanText(payload.nickname, 32);
      const id = rid();
      const room = {
        id,
        name: cleanText(payload.name, 64),
        description: cleanText(payload.description || '', 220),
        projectName: cleanText(payload.projectName || payload.name || 'MAPCG Project', 80),
        hostId: socket.id,
        hostName: nickname,
        createdAt: now(),
        updatedAt: now(),
        revision: 1,
        maxPlayers: Math.max(2, Math.min(MAX_PLAYERS_PER_ROOM, Number(payload.maxPlayers || MAX_PLAYERS_PER_ROOM))),
        permissions: {
          guestsCanBuild: payload.permissions?.guestsCanBuild !== false,
          guestsCanChat: payload.permissions?.guestsCanChat !== false
        },
        mapData: payload.mapData || { blocks: [], lights: [], env: null },
        players: new Map(),
        chat: [],
        closeTimer: null
      };
      const player = {
        id: socket.id,
        nickname,
        role: 'admin',
        status: 'admin',
        ping: 0,
        joinedAt: now(),
        color: colorFor(socket.id)
      };
      room.players.set(socket.id, player);
      rooms.set(id, room);
      socketToRoom.set(socket.id, id);
      socket.join(id);
      socket.emit('mp:joined', {
        room: publicRoom(room),
        self: publicPlayer(player),
        players: [...room.players.values()].map(publicPlayer),
        mapData: room.mapData,
        chat: room.chat
      });
      broadcastRoomList();
      if (typeof cb === 'function') cb({ ok: true, room: publicRoom(room), self: publicPlayer(player) });
    } catch (err) {
      if (typeof cb === 'function') cb({ ok: false, error: err.message || String(err) });
      else socket.emit('mp:error', { error: err.message || String(err) });
    }
  });

  socket.on('mp:join_room', (payload = {}, cb) => {
    try {
      const room = rooms.get(String(payload.roomId || ''));
      if (!room) throw new Error('Server not found or already closed.');
      if (room.players.size >= room.maxPlayers) throw new Error('Server is full.');
      if (socketToRoom.has(socket.id)) {
        const old = roomOfSocket(socket);
        if (old) old.players.delete(socket.id);
      }
      const nickname = cleanText(payload.nickname, 32);
      const player = {
        id: socket.id,
        nickname,
        role: 'guest',
        status: 'guest',
        ping: 0,
        joinedAt: now(),
        color: colorFor(socket.id)
      };
      room.players.set(socket.id, player);
      socketToRoom.set(socket.id, room.id);
      socket.join(room.id);
      socket.emit('mp:joined', {
        room: publicRoom(room),
        self: publicPlayer(player),
        players: [...room.players.values()].map(publicPlayer),
        mapData: room.mapData,
        chat: room.chat
      });
      socket.to(room.id).emit('mp:player_joined', publicPlayer(player));
      emitPlayers(room);
      broadcastRoomList();
      if (typeof cb === 'function') cb({ ok: true, room: publicRoom(room), self: publicPlayer(player) });
    } catch (err) {
      if (typeof cb === 'function') cb({ ok: false, error: err.message || String(err) });
      else socket.emit('mp:error', { error: err.message || String(err) });
    }
  });

  socket.on('mp:leave_room', () => handleLeave(socket, 'Left'));

  socket.on('mp:map_update', (payload = {}, cb) => {
    const room = rooms.get(String(payload.roomId || socketToRoom.get(socket.id) || ''));
    if (!room) return cb?.({ ok: false, error: 'Room not found.' });
    if (!hasEditPermission(room, socket.id)) return cb?.({ ok: false, error: 'No build permission.' });
    if (!payload.mapData || typeof payload.mapData !== 'object') return cb?.({ ok: false, error: 'Invalid map update.' });
    room.mapData = payload.mapData;
    room.revision++;
    room.updatedAt = now();
    const author = room.players.get(socket.id);
    const packet = {
      roomId: room.id,
      revision: room.revision,
      authorId: socket.id,
      authorName: author?.nickname || 'Player',
      reason: cleanText(payload.reason || 'edit', 60),
      mapData: room.mapData,
      updatedAt: room.updatedAt
    };
    socket.to(room.id).emit('mp:map_update', packet);
    io.to(room.id).emit('mp:room_revision', { roomId: room.id, revision: room.revision, updatedAt: room.updatedAt });
    broadcastRoomList();
    cb?.({ ok: true, revision: room.revision });
  });

  socket.on('mp:set_permissions', (payload = {}, cb) => {
    const room = roomOfSocket(socket);
    if (!room) return cb?.({ ok: false, error: 'Not in room.' });
    if (socket.id !== room.hostId) return cb?.({ ok: false, error: 'Only admin can change permissions.' });
    room.permissions = {
      ...room.permissions,
      guestsCanBuild: payload.permissions?.guestsCanBuild !== false,
      guestsCanChat: payload.permissions?.guestsCanChat !== false
    };
    io.to(room.id).emit('mp:permissions', { permissions: room.permissions });
    broadcastRoomList();
    cb?.({ ok: true, permissions: room.permissions });
  });

  socket.on('mp:camera_update', payload => {
    const room = roomOfSocket(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.camera = payload?.camera || null;
    socket.to(room.id).emit('mp:camera_update', { playerId: socket.id, camera: p.camera });
  });

  socket.on('mp:chat', (payload = {}, cb) => {
    const room = roomOfSocket(socket);
    if (!room) return cb?.({ ok: false, error: 'Not in room.' });
    const player = room.players.get(socket.id);
    if (!player) return cb?.({ ok: false, error: 'Player not in room.' });
    if (player.role !== 'admin' && room.permissions?.guestsCanChat === false) return cb?.({ ok: false, error: 'Chat is disabled for guests.' });
    const text = cleanText(payload.text, MAX_CHAT_LEN);
    if (!text) return cb?.({ ok: false, error: 'Empty message.' });
    const msg = { id: rid(), playerId: socket.id, nickname: player.nickname, role: player.role, color: player.color, text, time: now() };
    room.chat.push(msg);
    if (room.chat.length > MAX_CHAT_HISTORY) room.chat.splice(0, room.chat.length - MAX_CHAT_HISTORY);
    io.to(room.id).emit('mp:chat', msg);
    cb?.({ ok: true });
  });

  socket.on('mp:ping', (payload = {}, cb) => {
    const room = roomOfSocket(socket);
    const clientTime = Number(payload.clientTime || now());
    if (room && room.players.has(socket.id)) {
      const rtt = Math.max(0, now() - clientTime);
      room.players.get(socket.id).ping = rtt;
      emitPlayers(room);
    }
    cb?.({ ok: true, serverTime: now(), clientTime });
  });

  socket.on('mp:kick', (payload = {}, cb) => {
    const room = roomOfSocket(socket);
    if (!room) return cb?.({ ok: false, error: 'Not in room.' });
    if (socket.id !== room.hostId) return cb?.({ ok: false, error: 'Only admin can kick.' });
    const targetId = String(payload.playerId || '');
    if (!room.players.has(targetId) || targetId === room.hostId) return cb?.({ ok: false, error: 'Invalid player.' });
    const target = io.sockets.sockets.get(targetId);
    if (target) {
      target.emit('mp:kicked', { reason: 'Kicked by admin.' });
      handleLeave(target, 'Kicked');
    }
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => handleLeave(socket, 'Disconnected'));
});

function handleLeave(socket, reason) {
  const roomId = socketToRoom.get(socket.id);
  if (!roomId) return;
  const room = rooms.get(roomId);
  socketToRoom.delete(socket.id);
  if (!room) return;
  const player = room.players.get(socket.id);
  room.players.delete(socket.id);
  socket.leave(roomId);
  if (socket.id === room.hostId) {
    if (room.closeTimer) clearTimeout(room.closeTimer);
    room.closeTimer = setTimeout(() => closeRoom(room, 'Host left the server. The map was not saved on the backend.'), ROOM_IDLE_CLOSE_MS);
    io.to(room.id).emit('mp:host_left', { reason: 'Host left. Closing room soon.' });
  } else {
    socket.to(room.id).emit('mp:player_left', { playerId: socket.id, nickname: player?.nickname, reason });
    emitPlayers(room);
    broadcastRoomList();
  }
}

server.listen(PORT, () => {
  console.log(`MAPCG Multiplayer Server listening on port ${PORT}`);
});
