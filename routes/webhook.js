// src/routes/webhook.js
import dotenv from 'dotenv'
import { supabase } from '../services/db.js'
import { runFlow } from '../chatbot/flowExecutor.js'

dotenv.config()

export default async function webhookRoutes(fastify) {
  const io = fastify.io // ✅ Correção: acessa o Socket.IO via fastify

  // ─── 1) Verificação do Webhook ────────────────────────────────
  fastify.get('/', async (req, reply) => {
    const mode = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']

    if (mode && token === process.env.VERIFY_TOKEN) {
      return reply.code(200).send(challenge)
    }
    return reply.code(403).send('Forbidden')
  })

  // ─── 2) Processamento das mensagens recebidas ─────────────────
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

      let userMessage = ''
      switch (msgType) {
        case 'text':
          userMessage = msg.text?.body || ''
          break
        case 'interactive':
          userMessage = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || ''
          break
        case 'image':
          userMessage = '[imagem recebida]'
          break
        case 'video':
          userMessage = '[vídeo recebido]'
          break
        case 'audio':
          userMessage = '[áudio recebido]'
          break
        case 'document':
          userMessage = '[documento recebido]'
          break
        case 'location': {
          const { latitude, longitude } = msg.location || {}
          userMessage = `📍 Localização recebida: ${latitude}, ${longitude}`
          break
        }
        default:
          userMessage = `[tipo não tratado: ${msgType}]`
      }

      console.log(`🧾 Mensagem recebida de ${from} (${msgType} | id=${msgId}):`, userMessage)

      const { data: latestFlow } = await supabase
        .from('flows')
        .select('*')
        .eq('active', true)
        .limit(1)
        .single()

      const vars = {
        userPhone: from,
        userName: profileName,
        lastUserMessage: userMessage,
        channel: 'whatsapp',
        now: new Date().toISOString(),
        lastMessageId: msgId
      }

      const formattedUserId = `${from}@w.msgcli.net`

      const { data: insertedMessages, error } = await supabase.from('messages').insert([{
        user_id: formattedUserId,
        whatsapp_message_id: msgId,
        direction: 'incoming',
        type: msgType,
        content: userMessage,
        timestamp: new Date().toISOString(),
        flow_id: latestFlow?.data?.id || null,
        agent_id: null,
        queue_id: null,
        status: 'received',
        metadata: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }]).select('*')

      if (error) {
        console.error('❌ Erro ao gravar mensagem:', error)
      }

      // 🚀 Emissão via WebSocket após gravação
      if (io && insertedMessages?.length > 0) {
        const emitPayload = insertedMessages[0]
        setTimeout(() => {
          console.log('📡 Emitindo new_message:', emitPayload)
          io.emit('new_message', emitPayload)
          io.to(`chat-${formattedUserId}`).emit('new_message', emitPayload)
        }, 200)
      } else {
        console.warn('⚠️ io ou mensagens não disponíveis para emitir.')
      }

      // ⏳ Status de processamento do bot
      if (io) {
        const statusPayload = {
          user_id: formattedUserId,
          status: 'processing'
        }
        console.log('⏳ Emitindo bot_processing:', statusPayload)
        io.emit('bot_processing', statusPayload)
        io.to(`chat-${formattedUserId}`).emit('bot_processing', statusPayload)
      }

      // 🤖 Executa lógica do bot
      const botResponse = await runFlow({
        message: userMessage.toLowerCase(),
        flow: latestFlow?.data,
        vars,
        rawUserId: from
      })

      console.log('🤖 Resposta do bot:', botResponse)

      // 🚀 Emissão da resposta do bot
// 🚀 Emissão como "new_message" se for uma resposta gravada (outgoing)
if (io && botResponse?.id && botResponse?.direction === 'outgoing') {
  console.log('📡 Emitindo new_message (outgoing):', botResponse)
  io.emit('new_message', botResponse)
  io.to(`chat-${formattedUserId}`).emit('new_message', botResponse)
} else {
  console.warn('⚠️ botResponse não tem estrutura esperada para emissão.')
}
    }

    return reply.code(200).send('EVENT_RECEIVED')
  })
}
