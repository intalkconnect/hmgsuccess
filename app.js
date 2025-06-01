// app.js
import Fastify from 'fastify'
import cors from '@fastify/cors'
import dotenv from 'dotenv'
import { Server as IOServer } from 'socket.io'

import webhookRoutes from './routes/webhook.js'
import messageRoutes from './routes/messages.js'
import flowRoutes from './routes/flow.js'
import { initDB, supabase } from './services/db.js'

dotenv.config()

async function buildServer() {
  const fastify = Fastify({ logger: true })

  // 1) CORS
  await fastify.register(cors, {
    origin: '*' // em produção, restrinja ao seu domínio
  })

  // 2) Inicializa conexão com Supabase
  await initDB()

  // 3) Registra as rotas existentes (sem nenhuma mudança)
  fastify.register(webhookRoutes, { prefix: '/webhook' })
  fastify.register(messageRoutes, { prefix: '/messages' })
  fastify.register(flowRoutes, { prefix: '/flow' })

  return fastify
}

async function start() {
  const fastify = await buildServer()

  // 4) Aqui é a única diferença: criamos o Socket.IO acoplado ao fastify.server
  const io = new IOServer(fastify.server, {
    cors: {
      origin: '*' // em produção, define somente o domínio do front
    }
  })

  // 5) Lógica de conexão Socket.IO
  io.on('connection', (socket) => {
    fastify.log.info(`Socket conectado: ${socket.id}`)

    socket.on('join_room', (userId) => {
      socket.join(`chat-${userId}`)
      fastify.log.info(`Socket ${socket.id} entrou na sala chat-${userId}`)
    })

    socket.on('leave_room', (userId) => {
      socket.leave(`chat-${userId}`)
      fastify.log.info(`Socket ${socket.id} saiu da sala chat-${userId}`)
    })

    socket.on('disconnect', () => {
      fastify.log.info(`Socket desconectou: ${socket.id}`)
    })
  })

  // 6) Inscrição no Supabase Realtime (INSERT e UPDATE em “messages”)
  if (!supabase) {
    fastify.log.error('Supabase não inicializado antes de inscrever no Realtime')
  } else {
    // 6.1) INSERTs
    await supabase
      .channel('socketio-messages-insert')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const novaMsg = payload.new
          fastify.log.info('📥 Novo INSERT em messages:', novaMsg)

          io.emit('new_message', novaMsg)
          io.to(`chat-${novaMsg.user_id}`).emit('new_message', novaMsg)
        }
      )
      .subscribe()

    // 6.2) UPDATEs
    await supabase
      .channel('socketio-messages-update')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        (payload) => {
          const updatedMsg = payload.new
          fastify.log.info('🔄 UPDATE em messages:', updatedMsg)

          io.emit('update_message', updatedMsg)
          io.to(`chat-${updatedMsg.user_id}`).emit('update_message', updatedMsg)
        }
      )
      .subscribe()
  }

  // 7) Inicia o Fastify (que já carrega o Socket.IO via fastify.server)
  const PORT = process.env.PORT || 3000
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' })
    fastify.log.info(`Servidor rodando em http://0.0.0.0:${PORT}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
