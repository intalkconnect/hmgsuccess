// src/routes/messageRoutes.js

import dotenv from 'dotenv';
import { supabase } from '../services/db.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
import axios from 'axios';
dotenv.config();

export default async function messageRoutes(fastify, opts) {
  // ──────────────────────────────────────────────────────────────────────────
  // 1) ENVIA TEXTO, MÍDIA OU LOCALIZAÇÃO (/message/send)
  //    Usa sempre sendWhatsappMessage, que já cobre todos os tipos
  // ──────────────────────────────────────────────────────────────────────────
  fastify.post('/send', async (req, reply) => {
    const { to, type, content } = req.body;
    // Adiciona sufixo @w.msgcli.net para agrupar no mesmo user_id
    const userId = `${to}@w.msgcli.net`;

    try {
      // 1.1) Envia via sendWhatsappMessage (cobre text, image, audio, video, document, location)
      const result = await sendWhatsappMessage({ to, type, content });
      // 1.2) Extrai o ID retornado da API (geralmente em result.messages[0].id)
      const whatsappMsgId = result.messages?.[0]?.id || null;

      // 1.3) Grava no banco como outgoing
      await supabase.from('messages').insert([{
        user_id:             userId,
        whatsapp_message_id: whatsappMsgId,
        direction:           'outgoing',
        type:                type,
        content:             // Para texto, content é string. Para mídia, pode ser JSON.
          typeof content === 'string' ? content : JSON.stringify(content),
        timestamp:           new Date().toISOString(),
        flow_id:             null,
        agent_id:            null,
        queue_id:            null,
        status:              'sent',
        metadata:            null,
        created_at:          new Date().toISOString(),
        updated_at:          new Date().toISOString()
      }]);

      // 1.4) Retorna a resposta original da Graph API
      return reply.code(200).send(result);

    } catch (err) {
      const errorData = err.response?.data || err.message;
      fastify.log.error(errorData);

      // Se for fora da janela de 24h
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
  // 2) ENVIA TEMPLATE (/message/send/template)
  //    Mantido separado, pois payload é específico para template
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

      // Grava template como outgoing
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
  // 3) LISTA TEMPLATES (/message/templates)
  // ──────────────────────────────────────────────────────────────────────────
  fastify.get('/templates', async (req, reply) => {
    try {
      const res = await axios.get(
        `https://graph.facebook.com/${process.env.API_VERSION}/${process.env.PHONE_NUMBER_ID}/message_templates`,
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
