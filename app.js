// app.jsx (ou server.js / index.js — escolha um nome consistente)
import Fastify from 'fastify'
import cors from '@fastify/cors'
import dotenv from 'dotenv'
import http from 'http'
import { Server as IOServer } from 'socket.io'
import webhookRoutes from './routes/webhook.js'
import messageRoutes from './routes/messages.js'
import flowRoutes from './routes/flow.js'
import { initDB, getSupabaseClient } from './services/db.js' // vamos presumir que `getSupabaseClient` exporta o client supabase
// initDB deve conectar ao Supabase e guardar internamente o client

dotenv.config()

const fastify = Fastify({ logger: true })

// 1) Habilita CORS no Fastify
await fastify.register(cors, {
  origin: '*' // em produção, troque para o domínio do seu front
})

// 2) Inicializa a conexão com o Supabase (Postgres + Realtime)
//    Dentro de initDB(), você pode usar createClient(supabaseUrl, serviceRoleKey)
await initDB()

// 3) Registra suas rotas REST/HTTP
fastify.register(webhookRoutes, { prefix: '/webhook' })
fastify.register(messageRoutes, { prefix: '/messages' })
fastify.register(flowRoutes, { prefix: '/flow' })

// 4) Empacota o Fastify em um servidor HTTP “nativo” do Node
//    Para que possamos anexar o Socket.IO nele
const httpServer = http.createServer(fastify.server)

// 5) Cria o servidor Socket.IO “atrelado” ao mesmo HTTP server
const io = new IOServer(httpServer, {
  cors: {
    origin: '*' // em produção, substitua pelo domínio exato do seu front
  }
})

// 6) Quando um cliente se conectar via Socket.IO
io.on('connection', (socket) => {
  fastify.log.info(`⚡️ Socket conectado: ${socket.id}`)

  // 6.1) Se quiser que o cliente entre em “salas” (rooms) para conversas específicas:
  socket.on('join_room', (userId) => {
    socket.join(`chat-${userId}`)
    fastify.log.info(`Socket ${socket.id} entrou na sala chat-${userId}`)
  })

  socket.on('leave_room', (userId) => {
    socket.leave(`chat-${userId}`)
    fastify.log.info(`Socket ${socket.id} saiu da sala chat-${userId}`)
  })

  socket.on('disconnect', () => {
    fastify.log.info(`⚡️ Socket desconectou: ${socket.id}`)
  })
})

// 7) Inscreve‐se no Realtime do Supabase para capturar INSERTs/UPDATEs em “messages”
;(async () => {
  const supabase = getSupabaseClient() // pega o client criado em initDB()

  // 7.1) Canal para INSERTs em messages
  await supabase
    .channel('socket-io-messages-insert')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => {
        const novaMsg = payload.new
        fastify.log.info('👉 Novo INSERT em messages:', novaMsg)

        // 7.1.1) Emite para todos os sockets (broadcast global)
        io.emit('new_message', novaMsg)

        // 7.1.2) (Opcional) Emite apenas para quem entrou na sala “chat‐<user_id>”
        io.to(`chat-${novaMsg.user_id}`).emit('new_message', novaMsg)
      }
    )
    .subscribe()

  // 7.2) Se quiser também escutar UPDATEs (por exemplo, mudança de status)
  await supabase
    .channel('socket-io-messages-update')
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

// 8) Inicia o servidor HTTP ‒ e, junto com ele, o Socket.IO
const PORT = process.env.PORT || 3000
httpServer.listen(PORT, '0.0.0.0', (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  fastify.log.info(`Servidor rodando (HTTP + Socket.IO) em http://0.0.0.0:${PORT}`)
})
