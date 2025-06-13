import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyPostgres from '@fastify/postgres';
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

async function buildServer() {
  const fastify = Fastify({ logger: true });

  // Conexão com PostgreSQL via plugin
  await fastify.register(fastifyPostgres, {
    connectionString: process.env.PG_CONNECTION_STRING || process.env.DATABASE_URL,
  });

  await fastify.register(cors, {
    origin: '*',
    methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  });
  await fastify.register(multipart);

  // Migrações/Seed se existir
  if (initDB) {
    await initDB();
    fastify.log.info('[initDB] Migrações e seeds concluídos.');
  }

  fastify.log.info('[build] Servidor configurado.');
  return fastify;
}

async function start() {
  const fastify = await buildServer();
  const io = new IOServer(fastify.server, { cors: { origin: '*' } });
  fastify.decorate('io', io);

  // Mapa de presença
  const userStatusMap = new Map();

  // Atualiza status no banco
  async function updateAtendenteStatus(email, status) {
    try {
      await fastify.pg.query(
        'UPDATE atendentes SET status = $1, last_activity = NOW() WHERE email = $2',
        [status, email]
      );
      fastify.log.info(`[Status] ${email} → ${status}`);
    } catch (err) {
      fastify.log.error(err, `[Status] Erro ao atualizar ${email}`);
    }
  }

  io.on('connection', (socket) => {
    fastify.log.info(`[Socket.IO] Conectado: ${socket.id}`);
    const { auth } = socket.handshake;
    const email = auth?.email;
    if (!email) {
      fastify.log.warn(`[Socket.IO] Falta e-mail no handshake: ${socket.id}`);
      return socket.disconnect(true);
    }

    // Marca como online
    userStatusMap.set(email, { lastActivity: Date.now() });
    updateAtendenteStatus(email, 'online');

    // Heartbeat: mantém lastActivity atualizado
    socket.on('heartbeat', () => {
      const entry = userStatusMap.get(email);
      if (entry) entry.lastActivity = Date.now();
    });

    // Eventos manuais de presença
    socket.on('user_active', async () => {
      userStatusMap.set(email, { lastActivity: Date.now() });
      await updateAtendenteStatus(email, 'online');
    });
    socket.on('user_inactive', async () => {
      userStatusMap.set(email, { lastActivity: Date.now() });
      await updateAtendenteStatus(email, 'away');
    });

    // Join/Leave de salas
    socket.on('join_room', (userId) => {
      const room = `chat-${userId.includes('@') ? userId : `${userId}@w.msgcli.net`}`;
      socket.join(room);
      fastify.log.info(`[Socket.IO] ${socket.id} entrou em ${room}`);
    });
    socket.on('leave_room', (userId) => {
      const room = `chat-${userId.includes('@') ? userId : `${userId}@w.msgcli.net`}`;
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

  // Registra rotas REST
  fastify.register(webhookRoutes,   { prefix: '/webhook' });
  fastify.register(messageRoutes,   { prefix: '/api/v1/messages' });
  fastify.register(chatsRoutes,     { prefix: '/api/v1/chats' });
  fastify.register(flowRoutes,      { prefix: '/api/v1/flow' });
  fastify.register(uploadRoutes,    { prefix: '/api/v1/bucket' });
  fastify.register(clientesRoutes,  { prefix: '/api/v1/clientes' });
  fastify.register(settingsRoutes,  { prefix: '/api/v1/settings' });
  fastify.register(ticketsRoutes,   { prefix: '/api/v1/tickets' });
  fastify.register(filaRoutes,      { prefix: '/api/v1/filas' });
  fastify.register(atendentesRoutes, { prefix: '/api/v1/atendentes' });

  const PORT = process.env.PORT || 3000;
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`[start] Servidor rodando em :${PORT}`);
}

start();
