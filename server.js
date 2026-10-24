const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// rooms[id] = { chess, players:[socketId,...], colors:{socketId:'w'|'b'}, names:{w,b}, over, rematch:Set }
const rooms = {};

const cleanName = (n) => String(n || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Guest';
const other = (c) => (c === 'w' ? 'b' : 'w');

function buildState(room) {
  const chess = room.chess;
  const verbose = chess.history({ verbose: true });
  const last = verbose[verbose.length - 1];
  const legalSets = {};
  if (!room.over) {
    for (const m of chess.moves({ verbose: true })) {
      (legalSets[m.from] = legalSets[m.from] || new Set()).add(m.to);
    }
  }
  const legal = {};
  for (const k of Object.keys(legalSets)) legal[k] = [...legalSets[k]];
  return {
    fen: chess.fen(),
    turn: chess.turn(),
    inCheck: chess.inCheck(),
    moves: verbose.map((m) => ({ san: m.san, from: m.from, to: m.to, after: m.after, captured: !!m.captured })),
    lastMove: last ? { from: last.from, to: last.to } : null,
    legal,
    over: room.over || null,
    names: room.names,
  };
}

function detectOver(room) {
  const c = room.chess;
  if (c.isCheckmate()) room.over = { reason: 'checkmate', winner: other(c.turn()) };
  else if (c.isStalemate()) room.over = { reason: 'stalemate', winner: null };
  else if (c.isThreefoldRepetition()) room.over = { reason: 'repetition', winner: null };
  else if (c.isInsufficientMaterial()) room.over = { reason: 'insufficient', winner: null };
  else if (c.isDraw()) room.over = { reason: 'fifty', winner: null };
}

function opponentId(room, socket) {
  return room.players.find((id) => id !== socket.id);
}

function broadcast(roomId) {
  const room = rooms[roomId];
  if (room) io.to(roomId).emit('game_update', { state: buildState(room) });
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ name } = {}) => {
    const roomId = uuidv4().slice(0, 8);
    rooms[roomId] = {
      chess: new Chess(),
      players: [socket.id],
      colors: { [socket.id]: 'w' },
      names: { w: cleanName(name), b: 'Opponent' },
      over: null,
      rematch: new Set(),
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room_created', { roomId, color: 'w' });
  });

  socket.on('join_room', ({ roomId, name } = {}) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('err_msg', 'Game not found. The link may have expired.');
    if (room.players.length >= 2) return socket.emit('err_msg', 'This game already has two players.');
    room.players.push(socket.id);
    room.colors[socket.id] = 'b';
    room.names.b = cleanName(name);
    socket.join(roomId);
    socket.roomId = roomId;
    for (const id of room.players) {
      io.to(id).emit('game_start', { color: room.colors[id], state: buildState(room) });
    }
  });

  socket.on('move', ({ from, to, promotion } = {}) => {
    const room = rooms[socket.roomId];
    if (!room || room.over || room.players.length < 2) return;
    if (room.chess.turn() !== room.colors[socket.id]) return;
    try {
      room.chess.move({ from, to, promotion: promotion || 'q' });
    } catch (e) {
      return socket.emit('game_update', { state: buildState(room) });
    }
    detectOver(room);
    room.drawOfferFrom = null;
    broadcast(socket.roomId);
  });

  socket.on('resign', () => {
    const room = rooms[socket.roomId];
    if (!room || room.over || room.players.length < 2) return;
    room.over = { reason: 'resignation', winner: other(room.colors[socket.id]) };
    broadcast(socket.roomId);
  });

  socket.on('offer_draw', () => {
    const room = rooms[socket.roomId];
    if (!room || room.over || room.players.length < 2) return;
    room.drawOfferFrom = socket.id;
    io.to(opponentId(room, socket)).emit('draw_offered');
  });

  socket.on('respond_draw', ({ accept } = {}) => {
    const room = rooms[socket.roomId];
    if (!room || room.over || !room.drawOfferFrom || room.drawOfferFrom === socket.id) return;
    const offerer = room.drawOfferFrom;
    room.drawOfferFrom = null;
    if (accept) {
      room.over = { reason: 'agreement', winner: null };
      broadcast(socket.roomId);
    } else {
      io.to(offerer).emit('draw_declined');
    }
  });

  socket.on('rematch', () => {
    const room = rooms[socket.roomId];
    if (!room || !room.over || room.players.length < 2) return;
    room.rematch.add(socket.id);
    if (room.rematch.size < 2) {
      return io.to(opponentId(room, socket)).emit('rematch_offered');
    }
    room.rematch.clear();
    room.chess = new Chess();
    room.over = null;
    room.drawOfferFrom = null;
    for (const id of room.players) room.colors[id] = other(room.colors[id]);
    room.names = { w: room.names.b, b: room.names.w };
    for (const id of room.players) {
      io.to(id).emit('game_start', { color: room.colors[id], state: buildState(room) });
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    socket.to(roomId).emit('opponent_left');
    delete rooms[roomId];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chess server running on http://localhost:${PORT}`));
