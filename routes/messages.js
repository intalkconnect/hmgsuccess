// src/routes/messageRoutes.js

import dotenv from 'dotenv'
import { supabase } from '../services/db.js'
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js'
import axios from 'axios'
import crypto from 'crypto'

dotenv.config()

export default async function messageRoutes(fastify, opts) {
  // ──────────────────────────────────────────────────────────────────────────
  // 1) ENVIA QUALQUER TIPO (TEXT, IMAGE, AUDIO, LOCATION, INTERACTIVE etc)
  // ──────────────────────────────────────────────────────────────────────────
  fastify.post('/send', async (req, reply) => {
    const { to, type, content } = req.body
    // Garante o formato unificado de user_id
    const userId = `${to}@w.msgcli.net`

    try {
      // 1.1) Envia via sendWhatsappMessage
      const result = await sendWhatsappMessage({ to, type, content })

      // 1.2) Extrai message_id retornado
      const whatsappMsgId = result.messages?.[0]?.id || null

      // 1.3) Prepara objeto para inserção no Supabase
      const novaMensagem = {
        user_id:             userId,
        whatsapp_message_id: whatsappMsgId,
        direction:           'outgoing',
        type,                                 // ex: 'text', 'image', 'interactive', ...
        content:             JSON.stringify(content),
        timestamp:           new Date().toISOString(),
        flow_id:             null,
        agent_id:            null,
        queue_id:            null,
        status:              'sent',
        metadata:            null,
        created_at:          new Date().toISOString(),
        updated_at:          new Date().toISOString()
      }

      // 1.4) Insere no Supabase
      const { data, error } = await supabase
        .from('messages')
        .insert([novaMensagem])
        .select()

      if (error) {
        fastify.log.error('[messageRoutes] Erro ao inserir mensagem:', error)
        return reply.status(500).send({ error: 'Falha ao gravar mensagem no banco' })
      }

      const mensagemInserida = data[0]

      // 1.5) Emite evento via Socket.IO
      if (fastify.io) {
        fastify.log.info('[messageRoutes] Emitindo new_message via Socket.IO:', mensagemInserida)
        fastify.io.emit('new_message', mensagemInserida)
        fastify.io.to(`chat-${mensagemInserida.user_id}`).emit('new_message', mensagemInserida)
      }

      return reply.code(200).send(result)
    } catch (err) {
      const errorData = err.response?.data || err.message
      fastify.log.error(errorData)

      // Regra 24h (fora da janela)
      if (
        errorData?.error?.message?.includes('outside the allowed window') ||
        errorData?.error?.code === 131047
      ) {
        return reply.code(400).send({
          error: 'Mensagem fora da janela de 24 horas. Envie um template aprovado.'
        })
      }

      return reply.code(500).send({ error: 'Erro ao enviar mensagem' })
    }
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 2) ENVIA TEMPLATE (rota separada)
  // ──────────────────────────────────────────────────────────────────────────
  fastify.post('/send/template', async (req, reply) => {
    const { to, templateName, languageCode, components } = req.body
    const userId = `${to}@w.msgcli.net`

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name:       templateName,
        language:   { code: languageCode },
        components: components || []
      }
    }

    try {
      // 2.1) Envia template via API do Facebook/WhatsApp
      const res = await axios.post(
        `https://graph.facebook.com/${process.env.API_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      )

      // 2.2) Extrai message_id retornado
      const whatsappMsgId = res.data.messages?.[0]?.id || null

      // 2.3) Prepara objeto para inserção no Supabase
      const templateMensagem = {
        user_id:             userId,
        whatsapp_message_id: whatsappMsgId,
        direction:           'outgoing',
        type:                'template',
        content:             templateName,
        timestamp:           new Date().toISOString(),
        flow_id:             null,
        agent_id:            null,
        queue_id:            null,
        status:              'sent',
        metadata:            JSON.stringify({ languageCode, components }),
        created_at:          new Date().toISOString(),
        updated_at:          new Date().toISOString()
      }

      // 2.4) Insere no Supabase
      const { data, error } = await supabase
        .from('messages')
        .insert([templateMensagem])
        .select()

      if (error) {
        fastify.log.error('[messageRoutes] Erro ao inserir mensagem template:', error)
        return reply.status(500).send({ error: 'Falha ao gravar template no banco' })
      }

      const mensagemInserida = data[0]

      // 2.5) Emite evento via Socket.IO
      if (fastify.io) {
        fastify.log.info('[messageRoutes] Emitindo new_message (template) via Socket.IO:', mensagemInserida)
        fastify.io.emit('new_message', mensagemInserida)
        fastify.io.to(`chat-${mensagemInserida.user_id}`).emit('new_message', mensagemInserida)
      }

      return reply.code(200).send(res.data)
    } catch (err) {
      fastify.log.error(err.response?.data || err.message)
      return reply.code(500).send({ error: 'Erro ao enviar template' })
    }
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 3) LISTA TEMPLATES
  // ──────────────────────────────────────────────────────────────────────────
  fastify.get('/templates', async (req, reply) => {
    try {
      const res = await axios.get(
        `https://graph.facebook.com/${process.env.API_VERSION}/${process.env.WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`,
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      )
      return reply.code(200).send(res.data)
    } catch (err) {
      fastify.log.error(err.response?.data || err.message)
      return reply.code(500).send({ error: 'Erro ao listar templates' })
    }
  })
}
