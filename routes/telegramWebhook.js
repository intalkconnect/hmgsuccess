import dotenv from 'dotenv'
import { dbPool } from '../services/db.js'
import { runFlow } from '../chatbot/flowExecutor.js'

dotenv.config()

export default async function telegramWebhook(fastify) {
  const io = fastify.io

  // Telegram SEM rota GET, só POST para receber updates
  fastify.post('/', async (req, reply) => {
    const update = req.body
    if (!update.message) return reply.send('IGNORADO')

    const msg = update.message
    const from = msg.chat.id.toString()
    const profileName = msg.from?.username || msg.from?.first_name || 'usuário'
    const msgId = msg.message_id
    let msgType = 'text'
    let userMessage = ''
    let content = null

    // Trata tipos de mensagem: text, photo, document, etc.
    if (msg.text) {
      userMessage = msg.text
      content = msg.text
      msgType = 'text'
    } else if (msg.photo) {
      msgType = 'photo'
      userMessage = '[imagem recebida]'
      // pode salvar o file_id ou tratar depois
      content = JSON.stringify({
        file_id: msg.photo[msg.photo.length - 1].file_id,
        caption: msg.caption || '[imagem]'
      })
    } else if (msg.document) {
      msgType = 'document'
      userMessage = '[documento recebido]'
      content = JSON.stringify({
        file_id: msg.document.file_id,
        filename: msg.document.file_name || 'documento'
      })
    } else {
      userMessage = '[tipo não tratado]'
      content = userMessage
    }

    console.log(`🧾 Mensagem Telegram de ${from} (${msgType} | id=${msgId}):`, userMessage)

    // Busca o fluxo ativo igual WhatsApp
    const { rows: [latestFlow] } = await dbPool.query(`
      SELECT * FROM flows 
      WHERE active = true 
      LIMIT 1
    `)

    const formattedUserId = `${from}@telegram`

    // Verifica e insere cliente (PostgreSQL)
    const { rows: [existingClient] } = await dbPool.query(`
      SELECT id FROM clientes 
      WHERE phone = $1 
      LIMIT 1
    `, [from])

    if (!existingClient) {
      try {
        await dbPool.query(`
          INSERT INTO clientes (phone, name, channel, user_id, create_at)
          VALUES ($1, $2, $3, $4, $5)
        `, [from, profileName, 'telegram', formattedUserId, new Date().toISOString()])
        console.log('✅ Cliente Telegram salvo:', from)
      } catch (insertError) {
        console.error('❌ Erro ao salvar cliente Telegram:', insertError)
      }
    }

    const vars = {
      userPhone: from,
      userName: profileName,
      lastUserMessage: userMessage,
      channel: 'telegram',
      now: new Date().toISOString(),
      lastMessageId: msgId
    }

    // Insere mensagem (PostgreSQL)
    try {
      const { rows: [insertedMessage] } = await dbPool.query(`
        INSERT INTO messages (
          user_id, message_id, direction, type, content,
          timestamp, flow_id, reply_to, status, metadata,
          created_at, updated_at, channel
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13
        ) RETURNING *
      `, [
        formattedUserId, msgId, 'incoming', msgType, content,
        new Date().toISOString(), latestFlow?.data?.id || null, null, 'received', null,
        new Date().toISOString(), new Date().toISOString(), 'telegram'
      ])

      // Emite mensagem recebida
      if (io && insertedMessage) {
        setTimeout(() => {
          console.log('📡 Emitindo new_message (incoming):', insertedMessage)
          io.emit('new_message', insertedMessage)
          io.to(`chat-${formattedUserId}`).emit('new_message', insertedMessage)
        }, 200)
      }

      // Status do bot
      if (io) {
        const statusPayload = {
          user_id: formattedUserId,
          status: 'processing'
        }
        console.log('⏳ Emitindo bot_processing:', statusPayload)
        io.emit('bot_processing', statusPayload)
        io.to(`chat-${formattedUserId}`).emit('bot_processing', statusPayload)
      }

      // Executa o fluxo do bot
      const outgoingMessage = await runFlow({
        message: userMessage.toLowerCase(),
        flow: latestFlow?.data,
        vars,
        rawUserId: from,
        io
      })

      // Emite resposta do bot
      if (io && outgoingMessage?.user_id) {
        console.log('📡 Emitindo new_message (outgoing):', outgoingMessage)
        io.emit('new_message', outgoingMessage)
        io.to(`chat-${formattedUserId}`).emit('new_message', outgoingMessage)
      } else {
        console.warn('⚠️ botResponse não foi emitido:', outgoingMessage)
      }

    } catch (error) {
      console.error('❌ Erro ao gravar mensagem Telegram:', error)
    }

    return reply.code(200).send('EVENT_RECEIVED')
  })
}
