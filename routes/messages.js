// src/routes/messageRoutes.js

import dotenv from 'dotenv';
import { supabase } from '../services/db.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
import axios from 'axios';
dotenv.config();

export default async function messageRoutes(fastify, opts) {
  // ──────────────────────────────────────────────────────────────────────────
  // 1) ENVIA QUALQUER TIPO (TEXT, IMAGE, AUDIO, LOCATION, INTERACTIVE etc)
  // ──────────────────────────────────────────────────────────────────────────
  fastify.post('/send', async (req, reply) => {
    const { to, type, content } = req.body;
    // Garante o formato unificado de user_id
    const userId = `${to}@w.msgcli.net`;

    try {
      // Envia absolutamente TUDO via sendWhatsappMessage
      // Basta que `type` esteja correto e `content` contenha a estrutura adequada.
      const result = await sendWhatsappMessage({ to, type, content });

      // Extrai message_id retornado (normalmente em result.messages[0].id)
      const whatsappMsgId = result.messages?.[0]?.id || null;

      // Grava no banco como outgoing
      await supabase.from('messages').insert([{
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
      }]);

      return reply.code(200).send(result);

    } catch (err) {
      const errorData = err.response?.data || err.message;
      fastify.log.error(errorData);

      // Regra 24h (fora da janela)
      if (
        errorData?.error?.message?.includes('outside the allowed window') ||
        errorData?.error?.code === 131047
      ) {
        return reply.code(400).send({
          error: 'Mensagem fora da janela de 24 horas. Envie um template aprovado.',
        });
      }

      return reply.code(500).send({ error: 'Erro ao enviar mensagem' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2) ENVIA TEMPLATE (rota separada)
  // ──────────────────────────────────────────────────────────────────────────
  fastify.post('/send/template', async (req, reply) => {
    const { to, templateName, languageCode, components } = req.body;
    const userId = `${to}@w.msgcli.net`;

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name:       templateName,
        language:   { code: languageCode },
        components: components || []
      }
    };

    try {
      const res = await axios.post(
        `https://graph.facebook.com/${process.env.API_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const whatsappMsgId = res.data.messages?.[0]?.id || null;

      await supabase.from('messages').insert([{
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
      }]);

      return reply.code(200).send(res.data);
    } catch (err) {
      fastify.log.error(err.response?.data || err.message);
      return reply.code(500).send({ error: 'Erro ao enviar template' });
    }
  });

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
      );
      return reply.code(200).send(res.data);
    } catch (err) {
      fastify.log.error(err.response?.data || err.message);
      return reply.code(500).send({ error: 'Erro ao listar templates' });
    }
  });
}
