const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// rooms[roomId] = { chess, players: [socketId, socketId], colors: {socketId: 'w'|'b'} }
const rooms = {};

io.on('connection', (socket) => {

  // Create a new game room
  socket.on('create_room', () => {
    const roomId = uuidv4().slice(0, 8);
    rooms[roomId] = {
      chess: new Chess(),
      players: [socket.id],
      colors: { [socket.id]: 'w' },
    };
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room_created', { roomId, color: 'w' });
  });

  // Join an existing room
  socket.on('join_room', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('error', 'Room not found.');
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error', 'Room is full.');
      return;
    }
    room.players.push(socket.id);
    room.colors[socket.id] = 'b';
    socket.join(roomId);
    socket.roomId = roomId;

    // Tell both players the game is starting
    socket.emit('game_start', { color: 'b', fen: room.chess.fen() });
    const hostId = room.players[0];
    io.to(hostId).emit('game_start', { color: 'w', fen: room.chess.fen() });
  });

  // Player makes a move
  socket.on('move', ({ from, to, promotion }) => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room) return;

    const chess = room.chess;
    const myColor = room.colors[socket.id];

    // It must be this player's turn
    if (chess.turn() !== myColor) return;

    let result;
    try {
      result = chess.move({ from, to, promotion: promotion || 'q' });
    } catch (e) {
      socket.emit('invalid_move');
      return;
    }

    if (!result) {
      socket.emit('invalid_move');
      return;
    }

    const state = {
      fen: chess.fen(),
      lastMove: { from, to },
      turn: chess.turn(),
      inCheck: chess.inCheck(),
      isGameOver: chess.isGameOver(),
      isCheckmate: chess.isCheckmate(),
      isStalemate: chess.isStalemate(),
      isDraw: chess.isDraw(),
    };

    io.to(roomId).emit('game_update', state);
  });

  // Rematch request
  socket.on('rematch', () => {
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room) return;
    room.chess = new Chess();
    // Swap colors
    for (const id of room.players) {
      room.colors[id] = room.colors[id] === 'w' ? 'b' : 'w';
    }
    room.players.forEach(id => {
      io.to(id).emit('game_start', { color: room.colors[id], fen: room.chess.fen() });
    });
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    io.to(roomId).emit('opponent_left');
    delete rooms[roomId];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chess server running on http://localhost:${PORT}`));
