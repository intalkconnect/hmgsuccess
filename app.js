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

  // 1) Habilita CORS
  await fastify.register(cors, {
    origin: '*' // Em produção, restrinja ao domínio do front
  })

  // 2) Inicializa conexão com Supabase
  fastify.log.info('[initDB] Iniciando conexão com o Supabase...')
  await initDB()
  fastify.log.info('[initDB] Conexão com Supabase estabelecida.')

  // 3) Registra as rotas existentes (sem nenhuma mudança)
  fastify.log.info('[buildServer] Registrando rotas de webhook, messages e flow...')
  fastify.register(webhookRoutes, { prefix: '/webhook' })
  fastify.register(messageRoutes, { prefix: '/messages' })
  fastify.register(flowRoutes, { prefix: '/flow' })
  fastify.log.info('[buildServer] Rotas registradas com sucesso.')

  return fastify
}

async function start() {
  const fastify = await buildServer()

  // 4) Cria o servidor Socket.IO acoplado ao fastify.server
  fastify.log.info('[start] Configurando Socket.IO sobre o mesmo servidor HTTP...')
  const io = new IOServer(fastify.server, {
    cors: {
      origin: '*' // Em produção, defina só o domínio do front
    }
  })

  // 5) Lógica de conexão Socket.IO
  io.on('connection', (socket) => {
    fastify.log.info(`[Socket.IO] Cliente conectado: ${socket.id}`)

    socket.on('join_room', (userId) => {
      socket.join(`chat-${userId}`)
      fastify.log.info(`[Socket.IO] Socket ${socket.id} entrou na sala chat-${userId}`)
    })

    socket.on('leave_room', (userId) => {
      socket.leave(`chat-${userId}`)
      fastify.log.info(`[Socket.IO] Socket ${socket.id} saiu da sala chat-${userId}`)
    })

    socket.on('disconnect', (reason) => {
      fastify.log.info(`[Socket.IO] Cliente desconectado: ${socket.id} (reason=${reason})`)
    })
  })

  // 6) Inscrição no Supabase Realtime (INSERT e UPDATE em “messages”)
  if (!supabase) {
    fastify.log.error('[Realtime] Supabase não inicializado antes de inscrever no Realtime')
  } else {
    fastify.log.info('[Realtime] Inscrevendo no canal Realtime para INSERT em public.messages...')
    // 6.1) INSERTs
    await supabase
      .channel('socketio-messages-insert')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const novaMsg = payload.new
          fastify.log.info('[Realtime] 📥 Novo INSERT em messages:', novaMsg)

          // Broadcast para todos os conectados
          fastify.log.info('[Socket.IO] Emitindo evento new_message para todos os clientes')
          io.emit('new_message', novaMsg)

          // Envia apenas para a sala daquele user_id
          fastify.log.info(`[Socket.IO] Emitindo new_message para sala chat-${novaMsg.user_id}`)
          io.to(`chat-${novaMsg.user_id}`).emit('new_message', novaMsg)
        }
      )
      .subscribe()
      .then(() => {
        fastify.log.info('[Realtime] Inscrição para INSERT em messages concluída com sucesso.')
      })
      .catch((err) => {
        fastify.log.error('[Realtime] Falha ao inscrever INSERT em messages:', err)
      })

    fastify.log.info('[Realtime] Inscrevendo no canal Realtime para UPDATE em public.messages...')
    // 6.2) UPDATEs
    await supabase
      .channel('socketio-messages-update')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        (payload) => {
          const updatedMsg = payload.new
          fastify.log.info('[Realtime] 🔄 UPDATE em messages:', updatedMsg)

          fastify.log.info('[Socket.IO] Emitindo evento update_message para todos os clientes')
          io.emit('update_message', updatedMsg)

          fastify.log.info(`[Socket.IO] Emitindo update_message para sala chat-${updatedMsg.user_id}`)
          io.to(`chat-${updatedMsg.user_id}`).emit('update_message', updatedMsg)
        }
      )
      .subscribe()
      .then(() => {
        fastify.log.info('[Realtime] Inscrição para UPDATE em messages concluída com sucesso.')
      })
      .catch((err) => {
        fastify.log.error('[Realtime] Falha ao inscrever UPDATE em messages:', err)
      })
  }

  // 7) Inicia o Fastify (que já carrega o Socket.IO via fastify.server)
  const PORT = process.env.PORT || 3000
  try {
    fastify.log.info(`[start] Iniciando servidor HTTP + Socket.IO na porta ${PORT}...`)
    await fastify.listen({ port: PORT, host: '0.0.0.0' })
    fastify.log.info(`[start] Servidor rodando em http://0.0.0.0:${PORT}`)
  } catch (err) {
    fastify.log.error('[start] Erro ao iniciar servidor:', err)
    process.exit(1)
  }
}

start()
