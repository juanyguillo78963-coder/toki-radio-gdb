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

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, transports: ["websocket", "polling"] });

const rooms = new Map();
const getRoom = id => {
  if (!rooms.has(id)) rooms.set(id, new Map());
  return rooms.get(id);
};
const publicUsers = id => Array.from(getRoom(id).values()).map(u => ({
  id: u.id, name: u.name, speaking: u.speaking, joinedAt: u.joinedAt
}));

io.on("connection", socket => {
  socket.on("join-room", ({ roomId, name }) => {
    const room = String(roomId || "gases-belen").slice(0, 64);
    const cleanName = String(name || "Oyente").trim().slice(0, 32) || "Oyente";
    socket.join(room);
    socket.data.roomId = room;
    socket.data.name = cleanName;

    const state = getRoom(room);
    state.set(socket.id, { id: socket.id, name: cleanName, speaking: false, joinedAt: Date.now() });

    const existing = Array.from(state.keys()).filter(id => id !== socket.id);
    socket.emit("existing-peers", existing.map(id => ({ id, name: state.get(id)?.name || "Oyente" })));
    socket.to(room).emit("peer-joined", { id: socket.id, name: cleanName });
    io.to(room).emit("room-users", publicUsers(room));
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
    socket.to(room).emit("peer-speaking", { id: socket.id, speaking: !!value });
    io.to(room).emit("room-users", publicUsers(room));
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
    io.to(room).emit("room-users", publicUsers(room));
    if (!state.size) rooms.delete(room);
  });
});

server.listen(process.env.PORT || 3000, () => console.log("Radio Teléfono activo"));