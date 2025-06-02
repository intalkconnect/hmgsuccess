// app.js
import Fastify from 'fastify'
import cors from '@fastify/cors'
import dotenv from 'dotenv'
import { Server as IOServer } from 'socket.io'

import webhookRoutes from './routes/webhook.js'
import messageRoutes from './routes/messages.js'
import flowRoutes from './routes/flow.js'
import uploadRoutes from './routes/uploadRoutes.js'
import { initDB, supabase } from './services/db.js'

dotenv.config()

async function buildServer() {
  const fastify = Fastify({ logger: true })

  // 1) Habilita CORS
  await fastify.register(cors, {
    origin: '*' // em produção, restrinja ao domínio do front
  })

  // 2) Inicializa conexão com Supabase (sem subscrições Realtime)
  fastify.log.info('[initDB] Iniciando conexão com o Supabase...')
  await initDB()
  fastify.log.info('[initDB] Conexão com Supabase estabelecida.')

  return fastify
}

async function start() {
  const fastify = await buildServer()

  // 3) Cria o servidor Socket.IO atrelado ao mesmo HTTP do Fastify
  fastify.log.info('[start] Configurando Socket.IO sobre o servidor Fastify...')
  const io = new IOServer(fastify.server, {
    cors: {
      origin: '*' // em produção, restrinja ao domínio do front
    }
  })

  // 4) Anexa o io ao fastify para que as rotas possam usá‐lo
  fastify.decorate('io', io)

  // 5) Lógica de conexão Socket.IO (para debug/rooms)
  io.on('connection', (socket) => {
    fastify.log.info(`[Socket.IO] Cliente conectado: ${socket.id}`)

socket.on('join_room', (userId) => {
  const normalizedId = userId.includes('@') ? userId : `${userId}@w.msgcli.net`
  socket.join(`chat-${normalizedId}`)
  fastify.log.info(`[Socket.IO] Socket ${socket.id} entrou na sala chat-${normalizedId}`)
})


    socket.on('leave_room', (userId) => {
      socket.leave(`chat-${userId}`)
      fastify.log.info(`[Socket.IO] Socket ${socket.id} saiu da sala chat-${userId}`)
    })

    socket.on('disconnect', (reason) => {
      fastify.log.info(`[Socket.IO] Cliente desconectado: ${socket.id} (reason=${reason})`)
    })
  })

  // 6) Registra as rotas **depois** que o io estiver disponível
  fastify.log.info('[start] Registrando rotas de webhook, messages e flow...')
  fastify.register(webhookRoutes, { prefix: '/webhook' })
  fastify.register(messageRoutes, { prefix: '/messages' })
  fastify.register(flowRoutes, { prefix: '/flow' })
  fastify.register(uploadRoutes, { prefix: '/bucket' })
  fastify.log.info('[start] Rotas registradas com sucesso.')

  // 7) Inicia o Fastify (HTTP + Socket.IO)
  const PORT = process.env.PORT || 3000
  try {
    fastify.log.info(`[start] Iniciando servidor na porta ${PORT} (HTTP + Socket.IO)...`)
    await fastify.listen({ port: PORT, host: '0.0.0.0' })
    fastify.log.info(`[start] Servidor rodando em http://0.0.0.0:${PORT}`)
  } catch (err) {
    fastify.log.error(err, '[start] Erro ao iniciar servidor')
    process.exit(1)
  }
}

start()
