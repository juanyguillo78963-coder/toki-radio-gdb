const express = require("express");
const http = require("http");
const path = require("path");
const helmet = require("helmet");
const compression = require("compression");
const { Server } = require("socket.io");

const app = express();
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(express.static(path.join(__dirname, "public"), { maxAge: "30s" }));

app.get("/", (_, res) => res.redirect("/s/gases-belen"));
app.get("/s/:room", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/health", (_, res) => res.json({ ok: true, version: "SYNC-PRO-3-RADIO-FX", name: "Radio Telefono GDB" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
  pingInterval: 8000,
  pingTimeout: 24000,
  maxHttpBufferSize: 1e7
});

const rooms = new Map();
function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { users: new Map(), speakerId: null, speakerName: null, seq: 0 });
  return rooms.get(id);
}
function cleanName(name) {
  return String(name || "Oyente").trim().slice(0, 32) || "Oyente";
}
function publicUsers(roomId) {
  const room = getRoom(roomId);
  return Array.from(room.users.values())
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(u => ({ id: u.id, name: u.name, speaking: room.speakerId === u.id, joinedAt: u.joinedAt, online: true }));
}
function syncRoom(roomId) {
  const room = getRoom(roomId);
  io.to(roomId).emit("room-state", {
    seq: ++room.seq,
    users: publicUsers(roomId),
    speakerId: room.speakerId,
    speakerName: room.speakerName,
    count: room.users.size,
    serverTime: Date.now()
  });
}
function releaseSpeaker(roomId, socketId) {
  const room = getRoom(roomId);
  if (room.speakerId === socketId) {
    room.speakerId = null;
    room.speakerName = null;
    io.to(roomId).emit("talk-ended", { id: socketId });
    syncRoom(roomId);
  }
}

io.on("connection", socket => {
  socket.on("join-room", ({ roomId, name }) => {
    const roomName = String(roomId || "gases-belen").replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 64) || "gases-belen";
    const userName = cleanName(name);

    if (socket.data.roomId && socket.data.roomId !== roomName) {
      releaseSpeaker(socket.data.roomId, socket.id);
      socket.leave(socket.data.roomId);
    }

    socket.join(roomName);
    socket.data.roomId = roomName;
    socket.data.name = userName;
    socket.data.lastSeen = Date.now();

    const room = getRoom(roomName);
    room.users.set(socket.id, {
      id: socket.id,
      name: userName,
      joinedAt: room.users.get(socket.id)?.joinedAt || Date.now(),
      lastSeen: Date.now()
    });

    const existing = Array.from(room.users.values())
      .filter(u => u.id !== socket.id)
      .map(u => ({ id: u.id, name: u.name }));

    socket.emit("joined", { id: socket.id, roomId: roomName, users: publicUsers(roomName), speakerId: room.speakerId, speakerName: room.speakerName });
    socket.emit("existing-peers", existing);
    socket.to(roomName).emit("peer-joined", { id: socket.id, name: userName });
    syncRoom(roomName);
  });

  socket.on("request-sync", () => {
    const room = socket.data.roomId;
    if (!room) return;
    const user = getRoom(room).users.get(socket.id);
    if (user) user.lastSeen = Date.now();
    syncRoom(room);
  });

  socket.on("signal", ({ to, data }) => {
    if (to && data) io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("request-talk", ack => {
    const roomId = socket.data.roomId;
    if (!roomId) return typeof ack === "function" && ack({ ok: false, reason: "No estás conectado" });
    const room = getRoom(roomId);
    const user = room.users.get(socket.id);
    if (!user) return typeof ack === "function" && ack({ ok: false, reason: "Usuario no encontrado" });

    if (room.speakerId && room.speakerId !== socket.id) {
      return typeof ack === "function" && ack({ ok: false, busy: true, speakerId: room.speakerId, speakerName: room.speakerName || "Otro usuario" });
    }

    room.speakerId = socket.id;
    room.speakerName = user.name;
    io.to(roomId).emit("talk-started", { id: socket.id, name: user.name });
    syncRoom(roomId);
    return typeof ack === "function" && ack({ ok: true });
  });

  socket.on("release-talk", () => {
    const room = socket.data.roomId;
    if (room) releaseSpeaker(room, socket.id);
  });

  socket.on("speaking", value => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    const user = room.users.get(socket.id);
    if (!user) return;
    if (value && room.speakerId !== socket.id) return;
    if (!value) return releaseSpeaker(roomId, socket.id);
    io.to(roomId).emit("peer-speaking", { id: socket.id, speaking: true, name: user.name });
    syncRoom(roomId);
  });

  socket.on("chat", value => {
    const room = socket.data.roomId;
    if (!room) return;
    const text = String(value || "").trim().slice(0, 250);
    if (!text) return;
    io.to(room).emit("chat", {
      id: socket.id,
      name: socket.data.name || "Oyente",
      text,
      time: new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = getRoom(roomId);
    releaseSpeaker(roomId, socket.id);
    room.users.delete(socket.id);
    socket.to(roomId).emit("peer-left", { id: socket.id });
    syncRoom(roomId);
    if (!room.users.size) rooms.delete(roomId);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    for (const [id, user] of room.users) {
      if (now - user.lastSeen > 45000) {
        releaseSpeaker(roomId, id);
        room.users.delete(id);
        io.to(roomId).emit("peer-left", { id });
      }
    }
    if (!room.users.size) rooms.delete(roomId);
    else syncRoom(roomId);
  }
}, 5000);

server.listen(process.env.PORT || 3000, () => console.log("Radio Teléfono SYNC PRO 3 RADIO FX activo"));
