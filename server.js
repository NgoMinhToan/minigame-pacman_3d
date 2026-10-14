/**
 * PAC-MAN 3D — Web & Dedicated WebSocket Multiplayer Server
 * ---------------------------------------------------------
 * Cách chạy (How to run):
 *   1. Cài đặt thư viện: npm install
 *   2. Khởi chạy server: npm start (hoặc node server.js)
 *   3. Mở trình duyệt tại: http://localhost:8080
 *      (WebSocket tự động kết nối qua ws://localhost:8080)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

let WebSocketServer;
try {
  WebSocketServer = require('ws').Server;
} catch (err) {
  console.error('Thư viện "ws" chưa được cài đặt. Hãy chạy: npm install ws');
  process.exit(1);
}

const PORT = process.env.PORT || 8080;
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Serve Web Game
  if (pathname === '/' || pathname === '/index.html') {
    fs.readFile(INDEX_HTML_PATH, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Lỗi máy chủ: Không tìm thấy file index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Health / Status check
  if (pathname === '/health' || pathname === '/status' || pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      service: 'PAC-MAN 3D Multiplayer Server',
      status: 'online',
      rooms: Object.keys(rooms).length
    }));
    return;
  }

  // Favicon & Assets
  if (pathname === '/favicon.svg' || pathname === '/favicon.ico') {
    const faviconPath = path.join(__dirname, 'favicon.svg');
    fs.readFile(faviconPath, (err, data) => {
      if (err) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(data);
    });
    return;
  }

  if (pathname.startsWith('/assets/')) {
    const safePath = path.normalize(path.join(__dirname, pathname));
    if (safePath.startsWith(path.join(__dirname, 'assets'))) {
      fs.readFile(safePath, (err, data) => {
        if (!err) {
          const ext = path.extname(safePath).toLowerCase();
          const mimeTypes = {
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg'
          };
          res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
          res.end(data);
          return;
        }
      });
      return;
    }
  }

  // 404 Not Found
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

const wss = new WebSocketServer({ server });

// In-memory rooms store: { [roomCode]: { code, hostId, status, level, score, players: { [id]: { id, name, role, gx, gz, dirName, score } } } }
const rooms = {};

function broadcastRoomList() {
  const summary = Object.values(rooms).map((r) => ({
    code: r.code,
    status: r.status,
    playerCount: Object.keys(r.players).length,
    rolesTaken: Object.values(r.players).map((p) => p.role)
  }));
  const payload = JSON.stringify({ type: 'ROOM_LIST', rooms: summary });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

function broadcastToRoom(roomCode, messageObj, excludeWs = null) {
  const room = rooms[roomCode];
  if (!room) return;
  const raw = JSON.stringify(messageObj);
  Object.values(room.players).forEach((p) => {
    if (p.ws && p.ws !== excludeWs && p.ws.readyState === 1) {
      p.ws.send(raw);
    }
  });
}

function getSanitizedRoom(room) {
  if (!room) return null;
  const players = {};
  Object.values(room.players).forEach((p) => {
    players[p.id] = {
      id: p.id,
      name: p.name,
      role: p.role,
      gx: p.gx,
      gz: p.gz,
      dirName: p.dirName,
      score: p.score || 0,
      isHost: p.id === room.hostId
    };
  });
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    level: room.level,
    players
  };
}

wss.on('connection', (ws) => {
  let currentClientId = null;
  let currentRoomCode = null;

  // Send active rooms list immediately upon connection
  broadcastRoomList();

  ws.on('message', (rawMsg) => {
    let data;
    try {
      data = JSON.parse(rawMsg.toString());
    } catch (e) {
      return;
    }

    const { type } = data;

    if (type === 'CREATE_ROOM' || type === 'JOIN_ROOM') {
      const roomCode = (data.roomCode || '').trim().toUpperCase();
      const playerId = data.playerId;
      const playerName = (data.playerName || 'Player').slice(0, 18);
      let desiredRole = data.role || 'pacman';

      if (!roomCode || !playerId) return;

      if (type === 'CREATE_ROOM' && !rooms[roomCode]) {
        rooms[roomCode] = {
          code: roomCode,
          hostId: playerId,
          status: 'LOBBY',
          level: 1,
          players: {}
        };
      }

      const room = rooms[roomCode];
      if (!room) {
        ws.send(JSON.stringify({
          type: 'ERROR',
          message: `Không tìm thấy phòng mã "${roomCode}"!`
        }));
        return;
      }

      // Check if desiredRole is already taken by another player in this room
      const ALL_ROLES = ['pacman', 'Blinky', 'Pinky', 'Inky', 'Clyde'];
      const takenByOthers = new Set(
        Object.values(room.players)
          .filter((p) => p.id !== playerId)
          .map((p) => p.role)
      );

      if (takenByOthers.has(desiredRole)) {
        const freeRole = ALL_ROLES.find((r) => !takenByOthers.has(r));
        if (!freeRole) {
          ws.send(JSON.stringify({
            type: 'ERROR',
            message: `Phòng "${roomCode}" đã đủ 5/5 người chơi!`
          }));
          return;
        }
        desiredRole = freeRole;
      }

      currentClientId = playerId;
      currentRoomCode = roomCode;

      room.players[playerId] = {
        id: playerId,
        name: playerName,
        role: desiredRole,
        gx: desiredRole === 'pacman' ? 10 : 10,
        gz: desiredRole === 'pacman' ? 16 : 8,
        dirName: 'NONE',
        score: 0,
        ws
      };

      const sanitized = getSanitizedRoom(room);
      broadcastToRoom(roomCode, { type: 'ROOM_STATE', room: sanitized });
      broadcastRoomList();
    }

    else if (type === 'SELECT_ROLE') {
      const room = rooms[currentRoomCode];
      if (!room || !currentClientId || !room.players[currentClientId]) return;
      const newRole = data.role;
      const taken = Object.values(room.players).some(
        (p) => p.id !== currentClientId && p.role === newRole
      );
      if (!taken) {
        room.players[currentClientId].role = newRole;
        if (data.playerName) {
          room.players[currentClientId].name = data.playerName.slice(0, 18);
        }
        broadcastToRoom(currentRoomCode, {
          type: 'ROOM_STATE',
          room: getSanitizedRoom(room)
        });
        broadcastRoomList();
      }
    }

    else if (type === 'START_MATCH') {
      const room = rooms[currentRoomCode];
      if (!room) return;
      room.status = 'PLAYING';
      broadcastToRoom(currentRoomCode, {
        type: 'START_MATCH',
        room: getSanitizedRoom(room)
      });
      broadcastRoomList();
    }

    else if (type === 'PLAYER_SYNC') {
      const room = rooms[currentRoomCode];
      if (!room || !currentClientId || !room.players[currentClientId]) return;
      const p = room.players[currentClientId];
      p.gx = data.gx;
      p.gz = data.gz;
      p.dirName = data.dirName;
      if (typeof data.score === 'number') p.score = data.score;

      broadcastToRoom(currentRoomCode, {
        type: 'PLAYER_SYNC',
        playerId: currentClientId,
        role: p.role,
        name: p.name,
        gx: data.gx,
        gz: data.gz,
        dirName: data.dirName,
        dashTimer: data.dashTimer || 0,
        score: p.score
      }, ws);
    }

    else if (type === 'WORLD_EVENT') {
      if (!currentRoomCode) return;
      broadcastToRoom(currentRoomCode, data, ws);
    }

    else if (type === 'BOTS_SYNC') {
      if (!currentRoomCode) return;
      broadcastToRoom(currentRoomCode, data, ws);
    }

    else if (type === 'LEAVE_ROOM') {
      handleDisconnect();
    }
  });

  function handleDisconnect() {
    if (currentRoomCode && rooms[currentRoomCode] && currentClientId) {
      const room = rooms[currentRoomCode];
      delete room.players[currentClientId];
      const remainingIds = Object.keys(room.players);
      if (remainingIds.length === 0) {
        delete rooms[currentRoomCode];
      } else {
        if (room.hostId === currentClientId) {
          room.hostId = remainingIds[0];
        }
        broadcastToRoom(currentRoomCode, {
          type: 'ROOM_STATE',
          room: getSanitizedRoom(room)
        });
      }
      currentRoomCode = null;
      currentClientId = null;
      broadcastRoomList();
    }
  }

  ws.on('close', handleDisconnect);
});

server.listen(PORT, () => {
  console.log(`========================================================`);
  console.log(`🚀 PAC-MAN 3D Server đang chạy tại:`);
  console.log(`   - Web Game : http://localhost:${PORT}`);
  console.log(`   - WebSocket: ws://localhost:${PORT}`);
  console.log(`========================================================`);
});
