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

async function buildServer() {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, {
    origin: '*',
    methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  });
  await fastify.register(multipart);
  await initDB();
  fastify.log.info('[initDB] Conexão com PostgreSQL estabelecida.');
  return fastify;
}

async function start() {
  const fastify = await buildServer();
  const io = new IOServer(fastify.server, { cors: { origin: '*' } });
  fastify.decorate('io', io);

  io.on('connection', (socket) => {
    fastify.log.info(`[Socket.IO] Cliente conectado: ${socket.id}`);
    const email = socket.handshake.auth.email;
    if (!email) {
      fastify.log.warn(`[Socket.IO] Sem e-mail no handshake: ${socket.id}`);
      return;
    }

    // Evento para marcar online
    socket.on('atendente_online', async () => {
      try {
        await fastify.pg.query(
          'UPDATE atendentes SET status = $1 WHERE email = $2',
          ['online', email]
        );
        fastify.log.info(`[Socket.IO] Atendente online: ${email}`);
      } catch (err) {
        fastify.log.error(err, '[Socket.IO] Erro ao marcar atendente online');
      }
    });

    // Join nas salas de chat
    socket.on('join_room', (userId) => {
      const normalized = userId.includes('@') ? userId : `${userId}@w.msgcli.net`;
      socket.join(`chat-${normalized}`);
      fastify.log.info(`[Socket.IO] ${socket.id} entrou em chat-${normalized}`);
    });

    socket.on('leave_room', (userId) => {
      socket.leave(`chat-${userId}`);
      fastify.log.info(`[Socket.IO] ${socket.id} saiu de chat-${userId}`);
    });

    socket.on('disconnect', async (reason) => {
      fastify.log.info(`[Socket.IO] Desconectado ${socket.id} (razão=${reason})`);
      try {
        await fastify.pg.query(
          'UPDATE atendentes SET status = $1 WHERE email = $2',
          ['offline', email]
        );
        fastify.log.info(`[Socket.IO] Atendente offline: ${email}`);
      } catch (err) {
        fastify.log.error(err, '[Socket.IO] Erro ao marcar offline');
      }
    });
  });

  fastify.register(webhookRoutes, { prefix: '/webhook' });
  fastify.register(messageRoutes, { prefix: '/api/v1/messages' });
  fastify.register(chatsRoutes,   { prefix: '/api/v1/chats' });
  fastify.register(flowRoutes,    { prefix: '/api/v1/flow' });
  fastify.register(uploadRoutes,  { prefix: '/api/v1/bucket' });
  fastify.register(clientesRoutes,{ prefix: '/api/v1/clientes' });
  fastify.register(settingsRoutes,{ prefix: '/api/v1/settings' });
  fastify.register(ticketsRoutes, { prefix: '/api/v1/tickets' });
  fastify.register(filaRoutes,    { prefix: '/api/v1/filas' });
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
