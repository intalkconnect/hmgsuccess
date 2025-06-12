import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import dotenv from 'dotenv'
import { Server as IOServer } from 'socket.io'

import webhookRoutes from './routes/webhook.js'
import messageRoutes from './routes/messages.js'
import flowRoutes from './routes/flow.js'
import uploadRoutes from './routes/uploadRoutes.js'
import clientesRoutes from './routes/clientes.js';
import settingsRoutes from './routes/settings.js';
import ticketsRoutes from './routes/tickets.js';
import chatsRoutes from './routes/chats.js';
import filaRoutes from './routes/filas.js';
import atendentesRoutes from './routes/atendentes.js';

import { initDB } from './services/db.js'

dotenv.config()

async function buildServer() {
  const fastify = Fastify({ logger: true })

  await fastify.register(cors, {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  // allowedHeaders: ['Content-Type', 'Authorization'] // adicione se usa JWT ou headers customizados
})


  // Registro global do suporte a uploads multipart/form-data
  await fastify.register(multipart)

  await initDB()
  fastify.log.info('[initDB] Conexão com PostgreSQL estabelecida.') // Mensagem atualizada

  return fastify
}

async function start() {
  const fastify = await buildServer()

  const io = new IOServer(fastify.server, {
    cors: { origin: '*' }
  })

  fastify.decorate('io', io)

io.on('connection', async (socket) => {
  const email = socket.handshake.query.email;

  fastify.log.info(`[Socket.IO] Conectado: ${socket.id} (${email || 'sem email'})`);

  // Se tiver e-mail, atualiza status para online
  if (email) {
    try {
      await fastify.pg.query(
        `UPDATE atendentes SET status = 'online', updated_at = NOW() WHERE email = $1`,
        [email]
      );
      fastify.log.info(`[Socket.IO] Atendente ${email} marcado como ONLINE`);
    } catch (err) {
      fastify.log.error(err, `[Socket.IO] Erro ao marcar ${email} como online`);
    }
  }

  socket.on('disconnect', async (reason) => {
    fastify.log.info(`[Socket.IO] Desconectado: ${socket.id} (${email}) - ${reason}`);
    
    // Marca offline no banco
    if (email) {
      try {
        await fastify.pg.query(
          `UPDATE atendentes SET status = 'offline', updated_at = NOW() WHERE email = $1`,
          [email]
        );
        fastify.log.info(`[Socket.IO] Atendente ${email} marcado como OFFLINE`);
      } catch (err) {
        fastify.log.error(err, `[Socket.IO] Erro ao marcar ${email} como offline`);
      }
    }
  });

  socket.on('join_room', (userId) => {
    const normalizedId = userId.includes('@') ? userId : `${userId}@w.msgcli.net`;
    socket.join(`chat-${normalizedId}`);
    fastify.log.info(`[Socket.IO] Socket ${socket.id} entrou na sala chat-${normalizedId}`);
  });

  socket.on('leave_room', (userId) => {
    socket.leave(`chat-${userId}`);
    fastify.log.info(`[Socket.IO] Socket ${socket.id} saiu da sala chat-${userId}`);
  });
});


fastify.log.info('[start] Registrando rotas...')
fastify.register(webhookRoutes, { prefix: '/webhook' }) // permanece
fastify.register(messageRoutes, { prefix: '/api/v1/messages' })
fastify.register(chatsRoutes, { prefix: '/api/v1/chats' })
fastify.register(flowRoutes, { prefix: '/api/v1/flow' })
fastify.register(uploadRoutes, { prefix: '/api/v1/bucket' })
fastify.register(clientesRoutes, { prefix: '/api/v1/clientes' })
fastify.register(settingsRoutes, { prefix: '/api/v1/settings' })
fastify.register(ticketsRoutes, { prefix: '/api/v1/tickets' })
fastify.register(filaRoutes, { prefix: '/api/v1/filas' })
fastify.register(atendentesRoutes, { prefix: '/api/v1/atendentes' });
fastify.log.info('[start] Rotas registradas com sucesso.')

  const PORT = process.env.PORT || 3000
  try {
    fastify.log.info(`[start] Iniciando servidor na porta ${PORT}...`)
    await fastify.listen({ port: PORT, host: '0.0.0.0' })
    fastify.log.info(`[start] Servidor rodando em http://0.0.0.0:${PORT}`)
  } catch (err) {
    fastify.log.error(err, '[start] Erro ao iniciar servidor')
    process.exit(1)
  }
}

start()
