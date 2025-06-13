import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import dotenv from 'dotenv';
import { Server as IOServer } from 'socket.io';

import webhookRoutes from './routes/webhook.js';
import messageRoutes from './routes/messages.js';
import flowRoutes from './routes/flow.js';
import uploadRoutes from './routes/uploadRoutes.js';
import clientesRoutes from './routes/clientes.js';
import settingsRoutes from './routes/settings.js';
import ticketsRoutes from './routes/tickets.js';
import chatsRoutes from './routes/chats.js';
import filaRoutes from './routes/filas.js';
import atendentesRoutes from './routes/atendentes.js';
import { initDB } from './services/db.js';

dotenv.config();

// Configuração inicial do servidor
async function buildServer() {
  const fastify = Fastify({ logger: true });

  // CORS e multipart
  await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  });
  await fastify.register(multipart);

  // Inicializa conexão com o banco, passando o fastify para expor fastify.pg
  await initDB(fastify);
  fastify.log.info('[initDB] Conexão com PostgreSQL estabelecida.');

  return fastify;
}

// Inicia servidor e Socket.IO
async function start() {
  const fastify = await buildServer();
  const io = new IOServer(fastify.server, { cors: { origin: '*' } });
  fastify.decorate('io', io);

  // Map para acompanhar última atividade de cada email
  const userStatusMap = new Map();

  // Atualiza status no banco
  async function updateAtendenteStatus(email, status) {
    try {
      // fastify.pg deve agora existir
      await fastify.pg.query(
        'UPDATE atendentes SET status = $1, last_activity = NOW() WHERE email = $2',
        [status, email]
      );
      fastify.log.info(`[Status] Atendente ${email} → ${status}`);
    } catch (err) {
      fastify.log.error(err, `[Status] Erro ao atualizar ${email}`);
    }
  }

  io.on('connection', (socket) => {
    fastify.log.info(`[Socket.IO] Conectado: ${socket.id}`);

    // Tenta obter email de auth ou query
    const { auth, query } = socket.handshake;
    const email = auth?.email || query?.email;
    if (!email) {
      fastify.log.warn(`[Socket.IO] Falta email no handshake: ${socket.id}`);
      return socket.disconnect(true);
    }

    // Marca como online
    userStatusMap.set(email, { lastActivity: Date.now() });
    updateAtendenteStatus(email, 'online');

    // Heartbeat para manter lastActivity atualizado
    socket.on('heartbeat', () => {
      const entry = userStatusMap.get(email);
      if (entry) entry.lastActivity = Date.now();
    });

    // Presença manual
    socket.on('user_active', async () => {
      userStatusMap.set(email, { lastActivity: Date.now() });
      await updateAtendenteStatus(email, 'online');
    });
    socket.on('user_inactive', async () => {
      userStatusMap.set(email, { lastActivity: Date.now() });
      await updateAtendenteStatus(email, 'away');
    });

    // Entrar em salas
    socket.on('join_room', (userId) => {
      const normalized = userId.includes('@') ? userId : `${userId}@w.msgcli.net`;
      const room = `chat-${normalized}`;
      socket.join(room);
      fastify.log.info(`[Socket.IO] ${socket.id} entrou em ${room}`);
    });

    // Sair de salas
    socket.on('leave_room', (userId) => {
      const normalized = userId.includes('@') ? userId : `${userId}@w.msgcli.net`;
      const room = `chat-${normalized}`;
      socket.leave(room);
      fastify.log.info(`[Socket.IO] ${socket.id} saiu de ${room}`);
    });

    // Desconexão explícita
    socket.on('disconnect', async (reason) => {
      fastify.log.info(`[Socket.IO] Desconectado (${reason}): ${socket.id}`);
      userStatusMap.delete(email);
      await updateAtendenteStatus(email, 'offline');
    });
  });

  // Fallback de inatividade (>45s sem heartbeat)
  setInterval(() => {
    const now = Date.now();
    userStatusMap.forEach(async (entry, email) => {
      if (now - entry.lastActivity > 45000) {
        userStatusMap.delete(email);
        await updateAtendenteStatus(email, 'offline');
      }
    });
  }, 60000);

  // Rotas REST
  fastify.register(webhookRoutes,   { prefix: '/webhook' });
  fastify.register(messageRoutes,   { prefix: '/api/v1/messages' });
  fastify.register(chatsRoutes,     { prefix: '/api/v1/chats' });
  fastify.register(flowRoutes,      { prefix: '/api/v1/flow' });
  fastify.register(uploadRoutes,    { prefix: '/api/v1/bucket' });
  fastify.register(clientesRoutes,  { prefix: '/api/v1/clientes' });
  fastify.register(settingsRoutes,  { prefix: '/api/v1/settings' });
  fastify.register(ticketsRoutes,   { prefix: '/api/v1/tickets' });
  fastify.register(filaRoutes,      { prefix: '/api/v1/filas' });
  fastify.register(atendentesRoutes,{ prefix: '/api/v1/atendentes' });

  const PORT = process.env.PORT || 3000;
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`[start] Servidor rodando em http://0.0.0.0:${PORT}`);
  } catch (err) {
    fastify.log.error(err, '[start] Erro ao iniciar servidor');
    process.exit(1);
  }
}

start();
