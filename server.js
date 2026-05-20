const express = require("express");
const http = require("http");
const path = require("path");
const helmet = require("helmet");
const compression = require("compression");
const { Server } = require("socket.io");

const app = express();
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_, res) => res.redirect("/s/gases-belen"));
app.get("/s/:room", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/health", (_, res) => res.json({ ok: true, name: "Radio Telefono GDB" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
  pingInterval: 10000,
  pingTimeout: 25000,
  maxHttpBufferSize: 1e7
});

const rooms = new Map();
function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, new Map());
  return rooms.get(id);
}
function cleanName(name) {
  return String(name || "Oyente").trim().slice(0, 32) || "Oyente";
}
function publicUsers(roomId) {
  return Array.from(getRoom(roomId).values())
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(u => ({ id: u.id, name: u.name, speaking: u.speaking, joinedAt: u.joinedAt }));
}
function syncRoom(roomId) {
  io.to(roomId).emit("room-users", publicUsers(roomId));
}

io.on("connection", socket => {
  socket.on("join-room", ({ roomId, name }) => {
    const room = String(roomId || "gases-belen").slice(0, 64);
    const userName = cleanName(name);

    if (socket.data.roomId && socket.data.roomId !== room) socket.leave(socket.data.roomId);
    socket.join(room);
    socket.data.roomId = room;
    socket.data.name = userName;

    const state = getRoom(room);
    const isReconnect = state.has(socket.id);
    state.set(socket.id, { id: socket.id, name: userName, speaking: false, joinedAt: state.get(socket.id)?.joinedAt || Date.now() });

    const existing = Array.from(state.values())
      .filter(u => u.id !== socket.id)
      .map(u => ({ id: u.id, name: u.name }));

    socket.emit("joined", { id: socket.id, roomId: room, users: publicUsers(room) });
    socket.emit("existing-peers", existing);
    if (!isReconnect) socket.to(room).emit("peer-joined", { id: socket.id, name: userName });
    syncRoom(room);
  });

  socket.on("request-sync", () => {
    const room = socket.data.roomId;
    if (!room) return;
    syncRoom(room);
  });

  socket.on("signal", ({ to, data }) => {
    if (to && data) io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("speaking", value => {
    const room = socket.data.roomId;
    if (!room) return;
    const user = getRoom(room).get(socket.id);
    if (!user) return;
    user.speaking = !!value;
    socket.to(room).emit("peer-speaking", { id: socket.id, speaking: !!value, name: user.name });
    syncRoom(room);
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
    const room = socket.data.roomId;
    if (!room) return;
    const state = getRoom(room);
    state.delete(socket.id);
    socket.to(room).emit("peer-left", { id: socket.id });
    syncRoom(room);
    if (!state.size) rooms.delete(room);
  });
});

setInterval(() => {
  for (const roomId of rooms.keys()) syncRoom(roomId);
}, 3000);

server.listen(process.env.PORT || 3000, () => console.log("Radio Teléfono activo y sincronizado"));
