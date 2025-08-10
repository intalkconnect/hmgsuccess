// realtime/server.js
import Fastify from 'fastify';
import { Server } from 'socket.io';

const PORT = Number(process.env.SOCKET_PORT || 8080);
const PATH = process.env.SOCKET_PATH || '/socket.io';

const app = Fastify({ logger: true });

const io = new Server(app.server, {
  path: PATH,
  transports: ['websocket', 'polling'],
  cors: { origin: '*', credentials: true },
});

// tudo no namespace padrão "/"
io.on('connection', (socket) => {
  app.log.info({ id: socket.id }, 'socket conectado');

  // loga tudo que chega (debug)
  socket.onAny((event, ...args) => {
    app.log.info({ id: socket.id, event }, 'onAny');
  });

  // FRONT → entra/sai da sala (room === userId)
  socket.on('join_room', (userId) => {
    if (!userId) return;
    socket.join(String(userId));
    app.log.info({ id: socket.id, room: String(userId) }, 'join_room');
  });

  socket.on('leave_room', (userId) => {
    if (!userId) return;
    socket.leave(String(userId));
    app.log.info({ id: socket.id, room: String(userId) }, 'leave_room');
  });

  // WORKER (ou qualquer cliente) → pede pra emitir APENAS no room
  socket.on('server_emit', ({ room, event, data }) => {
    if (!room || !event) return;
    io.to(String(room)).emit(String(event), data);
    app.log.info({ room, event }, 'server_emit → broadcast');
  });

  socket.on('disconnect', (r) => {
    app.log.info({ id: socket.id, reason: r }, 'socket desconectado');
  });
});

app.get('/healthz', async () => ({ ok: true }));

app
  .listen({ host: '0.0.0.0', port: PORT })
  .then(() => app.log.info(`🔌 Socket.IO :${PORT}${PATH}`))
  .catch((e) => {
    app.log.error(e);
    process.exit(1);
  });

export { io };
