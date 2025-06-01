// src/routes/webhook.js

import dotenv from 'dotenv'
import { supabase } from '../services/db.js'
import { runFlow } from '../chatbot/flowExecutor.js'

dotenv.config()

export default async function webhookRoutes(fastify, opts) {
  // Verificação do Webhook
  fastify.get('/', async (req, reply) => {
    const mode      = req.query['hub.mode']
    const token     = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']

    if (mode && token === process.env.VERIFY_TOKEN) {
      return reply.code(200).send(challenge)
    }
    return reply.code(403).send('Forbidden')
  })

  // Processamento das mensagens recebidas
  fastify.post('/', async (req, reply) => {
    const body = req.body

    // Ignora eventos de status (para não poluir o log)
    const hasStatusesOnly = !!body.entry?.[0]?.changes?.[0]?.value?.statuses
    const hasMessages     = !!body.entry?.[0]?.changes?.[0]?.value?.messages

    if (!hasMessages || hasStatusesOnly) {
      return reply.code(200).send('EVENT_RECEIVED')
    }

    fastify.log.info('📩 Webhook POST recebido:', JSON.stringify(body, null, 2))

    const entry    = body.entry[0].changes[0].value
    const messages = entry.messages
    const contact  = entry.contacts?.[0]
    const from     = contact?.wa_id               // ex.: "5521990286724"
    const profileName = contact?.profile?.name || 'usuário'

    if (!(messages && messages.length > 0 && from)) {
      fastify.log.warn('[webhookRoutes] Mensagem ou remetente inválido.')
      return reply.code(200).send('EVENT_RECEIVED')
    }

    const msg     = messages[0]
    const msgId   = msg.id
    const msgType = msg.type

    // Normaliza payload do usuário para texto simples ou ID de interactive
    let userMessage = ''
    switch (msgType) {
      case 'text':
        userMessage = msg.text?.body || ''
        break
      case 'interactive':
        if (msg.interactive.type === 'button_reply') {
          userMessage = msg.interactive.button_reply.id
        } else if (msg.interactive.type === 'list_reply') {
          userMessage = msg.interactive.list_reply.id
        }
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

    fastify.log.info(`🧾 Mensagem recebida de ${from} (${msgType} | id=${msgId}):`, userMessage)

    // 1) Carrega o último fluxo ativo
    let latestFlow = null
    try {
      const { data, error } = await supabase
        .from('flows')
        .select('*')
        .eq('active', true)
        .limit(1)
        .single()

      if (error) {
        fastify.log.error('[webhookRoutes] Erro ao buscar latestFlow:', error)
      } else {
        latestFlow = data
        fastify.log.info('[webhookRoutes] latestFlow carregado:', latestFlow)
      }
    } catch (e) {
      fastify.log.error('[webhookRoutes] Exceção ao buscar latestFlow:', e)
    }

    // Prepara variáveis de sessão (rawUserId = from, sem sufixo)
    const vars = {
      userPhone:       from,
      userName:        profileName,
      lastUserMessage: userMessage,
      channel:         'whatsapp',
      now:             new Date().toISOString(),
      lastMessageId:   msgId
    }

    const formattedUserId = `${from}@w.msgcli.net`

    // 2) Grava mensagem “incoming” na tabela `messages`
    let mensagemInseridaIncoming = null
    try {
      const { data: insertedData, error: insertError } = await supabase
        .from('messages')
        .insert([{
          user_id:             formattedUserId,
          whatsapp_message_id: msgId,
          direction:           'incoming',
          type:                msgType,
          content:             userMessage,
          timestamp:           new Date().toISOString(),
          flow_id:             latestFlow?.id || null,
          agent_id:            null,
          queue_id:            null,
          status:              'received',
          metadata:            null,
          created_at:          new Date().toISOString(),
          updated_at:          new Date().toISOString()
        }])
        .select()

      if (insertError) {
        fastify.log.error('[webhookRoutes] Erro ao inserir mensagem incoming:', insertError)
      } else {
        mensagemInseridaIncoming = insertedData[0]
        fastify.log.info('[webhookRoutes] Mensagem incoming gravada:', mensagemInseridaIncoming)

        // Emite via Socket.IO para atualizar o front
        if (fastify.io) {
          fastify.io.emit('new_message', mensagemInseridaIncoming)
          fastify.io.to(`chat-${mensagemInseridaIncoming.user_id}`)
                      .emit('new_message', mensagemInseridaIncoming)
        }
      }
    } catch (e) {
      fastify.log.error('[webhookRoutes] Exceção ao inserir mensagem incoming:', e)
    }

    // 3) Processa a mensagem no engine (runFlow)
    let botResponse = null
    try {
      botResponse = await runFlow({
        message:   userMessage.toLowerCase(),
        flow:      latestFlow,
        vars,
        rawUserId: from   // runFlow monta `${rawUserId}@w.msgcli.net`
      })
      fastify.log.info('[webhookRoutes] runFlow retornou:', botResponse)
    } catch (flowExecError) {
      fastify.log.error('[webhookRoutes] Erro ao executar runFlow:', flowExecError)
    }

    // 4) A gravação e o envio do “outgoing” são feitos dentro de runFlow,
    // então não duplicamos essa lógica aqui.

    return reply.code(200).send('EVENT_RECEIVED')
  })
}
