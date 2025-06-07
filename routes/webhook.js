// src/routes/webhook.js
import dotenv from 'dotenv'
import { supabase } from '../services/db.js'
import { runFlow } from '../chatbot/flowExecutor.js'
import { markMessageAsRead } from '../services/wa/markMessageAsRead.js'

import axios from 'axios'
import { uploadToMinio } from '../services/uploadToMinio.js'


dotenv.config()

export default async function webhookRoutes(fastify) {
  const io = fastify.io

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

      if (['image', 'video', 'audio', 'document'].includes(msgType)) {
  try {
    const mediaId = msg[msgType]?.id

    // 1. Obter URL temporária da mídia
    const mediaUrlRes = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      }
    })

    const mediaUrl = mediaUrlRes.data.url
    const mimeType = msg[msgType]?.mime_type || 'application/octet-stream'

    // 2. Baixar o arquivo
    const mediaRes = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      }
    })

    const fileBuffer = mediaRes.data

    // 3. Upload para o MinIO
const extension = mimeType.split('/')[1] || 'bin'
const uploadedUrl = await uploadToMinio(fileBuffer, `${msgType}-${mediaId}.${extension}`, mimeType)


    // 4. Construir content final
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
  // Trata tipos de mensagem sem mídia
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

      const { data: latestFlow } = await supabase
        .from('flows')
        .select('*')
        .eq('active', true)
        .limit(1)
        .single()

          const formattedUserId = `${from}@w.msgcli.net`

          // 👤 Verifica se o cliente já está cadastrado
const { data: existingClient } = await supabase
  .from('clientes')
  .select('id')
  .eq('phone', from)
  .limit(1)
  .maybeSingle()

if (!existingClient) {
  const { error: insertError } = await supabase
    .from('clientes')
    .insert([{
      phone: from,
      name: profileName,
      channel: 'whatsapp',
      user_id: formattedUserId,
      create_at: new Date().toISOString()
    }])

  if (insertError) {
    console.error('❌ Erro ao salvar cliente:', insertError)
  } else {
    console.log('✅ Cliente salvo:', from)
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
      
      const { data: insertedMessages, error } = await supabase.from('messages').insert([{
        user_id: formattedUserId,
        whatsapp_message_id: msgId,
        direction: 'incoming',
        type: msgType,
        content: content,
        timestamp: new Date().toISOString(),
        flow_id: latestFlow?.data?.id || null,
        reply_to: msg.context?.id || null,
        status: 'received',
        metadata: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }]).select('*')

      if (error) {
        console.error('❌ Erro ao gravar mensagem:', error)
      }

      // 🚀 Emite mensagem recebida
      if (io && insertedMessages?.[0]) {
        const emitPayload = insertedMessages[0]
        setTimeout(() => {
          console.log('📡 Emitindo new_message (incoming):', emitPayload)
          io.emit('new_message', emitPayload)
          io.to(`chat-${formattedUserId}`).emit('new_message', emitPayload)
        }, 200)
      }

      // ⏳ Status do bot
      if (io) {
        const statusPayload = {
          user_id: formattedUserId,
          status: 'processing'
        }
        console.log('⏳ Emitindo bot_processing:', statusPayload)
        io.emit('bot_processing', statusPayload)
        io.to(`chat-${formattedUserId}`).emit('bot_processing', statusPayload)
      }

      // 🤖 Executa o fluxo do bot
      const outgoingMessage = await runFlow({
        message: userMessage.toLowerCase(),
        flow: latestFlow?.data,
        vars,
        rawUserId: from,
        io
      })

      // 🚀 Emite resposta do bot (como "new_message")
      if (io && outgoingMessage?.user_id) { 
        console.log('📡 Emitindo new_message (outgoing):', outgoingMessage)
        io.emit('new_message', outgoingMessage)
        io.to(`chat-${formattedUserId}`).emit('new_message', outgoingMessage)
      } else {
        console.warn('⚠️ botResponse não foi emitido:', outgoingMessage)
      }
    }

    return reply.code(200).send('EVENT_RECEIVED')
  })
}
