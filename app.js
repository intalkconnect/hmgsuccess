// app.js
import Fastify from 'fastify'
import cors from '@fastify/cors'
import dotenv from 'dotenv'
import http from 'http'
import { Server as IOServer } from 'socket.io'

import webhookRoutes from './routes/webhook.js'
import messageRoutes from './routes/messages.js'
import flowRoutes from './routes/flow.js'
import { initDB, supabase } from './services/db.js'

dotenv.config()

const fastify = Fastify({ logger: true })

// 1) Habilita CORS
await fastify.register(cors, {
  origin: '*' // em produção, restrinja ao domínio do seu front
})

// 2) Inicializa conexão com Supabase
await initDB()

// 3) Registra as rotas existentes (webhook, messages, flow)
fastify.register(webhookRoutes, { prefix: '/webhook' })
fastify.register(messageRoutes, { prefix: '/messages' })
fastify.register(flowRoutes, { prefix: '/flow' })

// 4) Empacota o Fastify num servidor HTTP nativo do Node
const httpServer = http.createServer(fastify.server)

// 5) Cria o servidor Socket.IO atrelado ao mesmo HTTP server
const io = new IOServer(httpServer, {
  cors: {
    origin: '*' // em produção, defina apenas o domínio necessário
  }
})

// 6) Quando um cliente se conecta via Socket.IO
io.on('connection', (socket) => {
  fastify.log.info(`Socket conectado: ${socket.id}`)

  // 6.1) Cliente entra em uma “sala” de chat específica
  socket.on('join_room', (userId) => {
    socket.join(`chat-${userId}`)
    fastify.log.info(`Socket ${socket.id} entrou na sala chat-${userId}`)
  })

  // 6.2) Cliente sai da sala
  socket.on('leave_room', (userId) => {
    socket.leave(`chat-${userId}`)
    fastify.log.info(`Socket ${socket.id} saiu da sala chat-${userId}`)
  })

  // 6.3) Cliente desconectou
  socket.on('disconnect', () => {
    fastify.log.info(`Socket desconectou: ${socket.id}`)
  })
})

// 7) Inscreve-se no Realtime do Supabase para INSERTs e UPDATEs em “messages”
;(async () => {
  if (!supabase) {
    fastify.log.error('Supabase não inicializado antes de inscrever no Realtime')
    return
  }

  // 7.1) Captura INSERTs em public.messages
  await supabase
    .channel('socketio-messages-insert')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => {
        const novaMsg = payload.new
        fastify.log.info('📥 Novo INSERT em messages:', novaMsg)

        // Envia para todos os sockets conectados
        io.emit('new_message', novaMsg)

        // Envia apenas para a sala daquele user_id
        io.to(`chat-${novaMsg.user_id}`).emit('new_message', novaMsg)
      }
    )
    .subscribe()

  // 7.2) Captura UPDATEs em public.messages
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
})()

// 8) Inicia o servidor HTTP + Socket.IO
const PORT = process.env.PORT || 3000
httpServer.listen(PORT, '0.0.0.0', (err, address) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  fastify.log.info(`Servidor rodando em ${address} (HTTP + Socket.IO)`)
})
