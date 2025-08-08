import dotenv from 'dotenv'
import { dbPool } from '../services/db.js'
import { runFlow } from '../engine/flowExecutor.js'
import { markMessageAsRead } from '../services/wa/markMessageAsRead.js'
import axios from 'axios'
import { uploadToMinio } from '../services/uploadToMinio.js'

dotenv.config()

export default async function webhookRoutes(fastify) {
  const io = fastify.io

  // Rota de verificação do webhook (inalterada)
  fastify.get('/', async (req, reply) => {
    const mode = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']

    if (mode && token === process.env.VERIFY_TOKEN) {
      return reply.code(200).send(challenge)
    }
    return reply.code(403).send('Forbidden')
  })

  fastify.post('/', async (req, reply) => {
    const body = req.body

    const hasStatusesOnly = !!body.entry?.[0]?.changes?.[0]?.value?.statuses
    const hasMessages = !!body.entry?.[0]?.changes?.[0]?.value?.messages

    if (!hasMessages || hasStatusesOnly) {
      return reply.code(200).send('EVENT_RECEIVED')
    }

    console.log('📩 Webhook POST recebido:', JSON.stringify(body, null, 2))

    const entry = body.entry[0].changes[0].value
    const messages = entry.messages
    const contact = entry.contacts?.[0]
    const from = contact?.wa_id
    const profileName = contact?.profile?.name || 'usuário'

    if (messages && messages.length > 0 && from) {
      const msg = messages[0]
      const msgId = msg.id
      const msgType = msg.type

      let content = null
      let userMessage = ''

      // Processamento de mídia (inalterado)
      if (['image', 'video', 'audio', 'document'].includes(msgType)) {
        try {
          const mediaId = msg[msgType]?.id
          const mediaUrlRes = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
            }
          })

          const mediaUrl = mediaUrlRes.data.url
          const mimeType = msg[msgType]?.mime_type || 'application/octet-stream'
          const mediaRes = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
            }
          })

          const fileBuffer = mediaRes.data
          const extension = mimeType.split('/')[1] || 'bin'
          const uploadedUrl = await uploadToMinio(fileBuffer, `${msgType}-${mediaId}.${extension}`, mimeType)

          if (msgType === 'audio') {
            content = JSON.stringify({ url: uploadedUrl })
            userMessage = '[áudio recebido]'
          } else {
            const filename = `${msgType}.${mimeType.split('/')[1]}`
            content = JSON.stringify({
              url: uploadedUrl,
              filename,
              caption: msg.caption || filename
            })
            userMessage = `[${msgType} recebido]`
          }
        } catch (err) {
          console.error(`❌ Erro ao tratar mídia do tipo ${msgType}:`, err)
          userMessage = `[${msgType} recebido - erro ao processar]`
          content = userMessage
        }
      } else {
        // Trata tipos de mensagem sem mídia (inalterado)
        switch (msgType) {
          case 'text':
            userMessage = msg.text?.body || ''
            content = userMessage
            break
          case 'interactive':
            userMessage = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || ''
            content = userMessage
            break
          case 'location':
            const { latitude, longitude } = msg.location || {}
            userMessage = `📍 Localização recebida: ${latitude}, ${longitude}`
            content = userMessage
            break
          default:
            userMessage = `[tipo não tratado: ${msgType}]`
            content = userMessage
        }
      }

      console.log(`🧾 Mensagem recebida de ${from} (${msgType} | id=${msgId}):`, userMessage)

      // Busca o fluxo ativo (PostgreSQL)
      const { rows: [latestFlow] } = await dbPool.query(`
        SELECT * FROM flows 
        WHERE active = true 
        LIMIT 1
      `)

      const formattedUserId = `${from}@w.msgcli.net`

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
          `, [from, profileName, 'whatsapp', formattedUserId, new Date().toISOString()])
          console.log('✅ Cliente salvo:', from)
        } catch (insertError) {
          console.error('❌ Erro ao salvar cliente:', insertError)
        }
      }

      const vars = {
        userPhone: from,
        userName: profileName,
        lastUserMessage: userMessage,
        channel: 'whatsapp',
        now: new Date().toISOString(),
        lastMessageId: msgId
      }

      markMessageAsRead(msgId)

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
          new Date().toISOString(), latestFlow?.data?.id || null, msg.context?.id || null, 'received', null,
          new Date().toISOString(), new Date().toISOString(), 'whatsapp'
        ])

        await dbPool.query(`
  UPDATE messages
  SET status = 'read'
  WHERE id = (
    SELECT id FROM messages
    WHERE user_id = $1
      AND direction = 'incoming'
      AND message_id != $2
      AND status != 'read'
    ORDER BY timestamp DESC
    LIMIT 1
  )
`, [formattedUserId, msgId]);

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
        console.error('❌ Erro ao gravar mensagem:', error)
      }
    }

    return reply.code(200).send('EVENT_RECEIVED')
  })
}


