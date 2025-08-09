// realtime/server.js
import Fastify from 'fastify';
import { Server } from 'socket.io';

const PORT       = Number(process.env.SOCKET_PORT || 8080);
const PATH       = process.env.SOCKET_PATH || '/socket.io';
const NAMESPACE  = process.env.SOCKET_NAMESPACE || '/';
const WORKER_KEY = process.env.SOCKET_TOKEN || ''; // token para autenticar o worker

const app = Fastify({ logger: true });
const io  = new Server(app.server, {
  path: PATH,
  transports: ['websocket', 'polling'],
  cors: { origin: '*', credentials: true },
});

// marca sockets autenticados como "worker"
io.use((socket, next) => {
  const hdr = socket.handshake?.headers?.authorization || '';
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7) : undefined;
  const authToken = socket.handshake?.auth?.token || bearer;
  socket.data.isWorker = !!(WORKER_KEY && authToken && authToken === WORKER_KEY);
  next();
});

const nsp = io.of(NAMESPACE);

nsp.on('connection', (socket) => {
  app.log.info({ id: socket.id, isWorker: socket.data.isWorker }, 'socket conectado');

  // FRONT → entra/ sai de uma sala (room === userId)
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

  // WORKER → pede para emitir APENAS no room
  socket.on('server_emit', ({ room, event, data }) => {
    if (!socket.data.isWorker) {
      app.log.warn('server_emit negado (não é worker)');
      return;
    }
    if (!room || !event) return;
    nsp.to(String(room)).emit(String(event), data);
  });

  socket.on('disconnect', (r) => {
    app.log.info({ id: socket.id, reason: r }, 'socket desconectado');
  });
});

app.get('/healthz', async () => ({ ok: true }));

app.listen({ host: '0.0.0.0', port: PORT })
  .then(() => app.log.info(`🔌 Socket.IO :${PORT}${PATH} ns=${NAMESPACE}`))
  .catch((e) => { app.log.error(e); process.exit(1); });

export { io };
