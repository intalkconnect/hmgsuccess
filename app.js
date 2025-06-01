// app.js
import Fastify from 'fastify'
import cors from '@fastify/cors'
import dotenv from 'dotenv'
import http from 'http'
import { Server as IOServer } from 'socket.io'

import webhookRoutes from './routes/webhook.js'
import messageRoutes from './routes/messages.js'
import flowRoutes from './routes/flow.js'
import { initDB, supabase } from './services/db.js' // vamos exportar supabase também

dotenv.config()

const fastify = Fastify({ logger: true })

// Habilita CORS
await fastify.register(cors, {
  origin: '*' // em produção, defina o domínio exato do seu front
})

// Inicializa conexão com Supabase
await initDB()

// Registra as rotas existentes, sem alteração
fastify.register(webhookRoutes, { prefix: '/webhook' })
fastify.register(messageRoutes, { prefix: '/messages' })
fastify.register(flowRoutes, { prefix: '/flow' })

// 1) Empacota o Fastify num servidor HTTP nativo
const httpServer = http.createServer(fastify.server)

// 2) Cria o Socket.IO atrelado ao mesmo HTTP server
const io = new IOServer(httpServer, {
  cors: {
    origin: '*' // em produção, restrinja ao domínio do front
  }
})

// 3) Trate conexões de cliente Socket.IO
io.on('connection', (socket) => {
  fastify.log.info(`Socket conectado: ${socket.id}`)

  socket.on('join_room', (userId) => {
    socket.join(`chat-${userId}`)
    fastify.log.info(`Socket ${socket.id} entrou em chat-${userId}`)
  })

  socket.on('leave_room', (userId) => {
    socket.leave(`chat-${userId}`)
    fastify.log.info(`Socket ${socket.id} saiu de chat-${userId}`)
  })

  socket.on('disconnect', () => {
    fastify.log.info(`Socket desconectou: ${socket.id}`)
  })
})

// 4) Inscreve‐se no Realtime do Supabase (captura INSERTs e UPDATEs em “messages”)
;(async () => {
  if (!supabase) {
    fastify.log.error('Supabase não inicializado antes de inscrever no Realtime')
    return
  }

  // 4.1) Captura INSERTs em public.messages
  await supabase
    .channel('socketio-messages-insert')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => {
        const novaMsg = payload.new
        fastify.log.info('Novo INSERT em messages:', novaMsg)

        // Envia para todos os sockets conectados
        io.emit('new_message', novaMsg)

        // Envia apenas para a sala daquele user_id
        io.to(`chat-${novaMsg.user_id}`).emit('new_message', novaMsg)
      }
    )
    .subscribe()

  // 4.2) Captura UPDATEs em public.messages
  await supabase
    .channel('socketio-messages-update')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'messages' },
      (payload) => {
        const updatedMsg = payload.new
        fastify.log.info('UPDATE em messages:', updatedMsg)

        io.emit('update_message', updatedMsg)
        io.to(`chat-${
