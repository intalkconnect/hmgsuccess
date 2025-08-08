// src/routes/messageRoutes.js
import dotenv from 'dotenv';
import { dbPool } from '../services/db.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
import { sendTelegramMessage } from '../services/sendTelegramMessage.js';
import axios from 'axios';

dotenv.config();

export default async function messageRoutes(fastify, opts) {
  // Helper para formatar o userId baseado no canal
  const formatUserId = (to, channel) => {
    return channel === 'telegram' 
      ? `${to}@t.msgcli.net`
      : `${to}@w.msgcli.net`;
  };

  // Helper para verificar janela de 24h
  const check24hWindow = async (userId) => {
    const { rows } = await dbPool.query(`
      SELECT timestamp FROM messages
      WHERE user_id = $1 AND direction = 'incoming'
      ORDER BY timestamp DESC
      LIMIT 1
    `, [userId]);

    if (!rows.length) return true; // Sem mensagens anteriores, permite envio

    const last = new Date(rows[0].timestamp);
    const diffInHours = (Date.now() - last.getTime()) / (1000 * 60 * 60);
    return diffInHours <= 24;
  };

  // ───────────────────────────────────────────────
  // ENVIO DE MENSAGENS COMUNS (MULTICANAL)
  // ───────────────────────────────────────────────
  fastify.post('/send', async (req, reply) => {
    const { to, type, content, context, channel = 'whatsapp' } = req.body;
    const userId = formatUserId(to, channel);

    try {
      // Verificação de janela de 24h apenas para WhatsApp
      if (channel === 'whatsapp') {
        const within24h = await check24hWindow(userId);
        if (!within24h) {
          return reply.code(400).send({
            error: 'Fora da janela de 24h. Envie um template aprovado.'
          });
        }
      }

      let result;
      let messageId;

      // Envio por canal
      if (channel === 'telegram') {
        result = await sendTelegramMessage({
          chatId: to,
          type,
          content: type === 'text' ? content.body : content
        });
        messageId = result.message_id;
      } else {
        // WhatsApp
        result = await sendWhatsappMessage({ to, type, content, context });
        messageId = result.messages?.[0]?.id;
      }

      // Preparar mensagem para o banco de dados
      const outgoingMsg = {
        user_id: userId,
        message_id: messageId,
        direction: 'outgoing',
        type,
        content: type === 'text' && typeof content === 'object' 
          ? content.body 
          : JSON.stringify(content),
        timestamp: new Date().toISOString(),
        flow_id: null,
        reply_to: context?.message_id || null,
        status: 'sent',
        metadata: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        channel,
      };

      // Inserir no banco de dados
      const { rows } = await dbPool.query(`
        INSERT INTO messages (
          user_id, message_id, direction, type, content,
          timestamp, flow_id, reply_to, status, metadata,
          created_at, updated_at, channel
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13
        ) RETURNING *;
      `, Object.values(outgoingMsg));

      const insertedMessage = rows[0];

      // Emitir via Socket.IO se disponível
      if (fastify.io) {
        fastify.io.emit('new_message', insertedMessage);
        fastify.io.to(`chat-${userId}`).emit('new_message', insertedMessage);
      }

      return reply.code(200).send(result);

    } catch (err) {
      fastify.log.error(`[messageRoutes] Erro ao enviar mensagem (${channel}):`, err.response?.data || err.message);

      // Tratamento específico para erros do WhatsApp
      if (channel === 'whatsapp') {
        const errorData = err.response?.data?.error;
        if (errorData?.code === 131047 || errorData?.message?.includes('24-hour window')) {
          return reply.code(400).send({
            error: 'Mensagem fora da janela de 24 horas. Envie um template aprovado.',
          });
        }
        if (errorData?.code === 131030) {
          return reply.code(400).send({
            error: 'Número não permitido. Adicione à lista de teste no Meta Developer.',
          });
        }
      }

      return reply.code(500).send({ 
        error: 'Erro ao enviar mensagem',
        details: err.response?.data || err.message 
      });
    }
  });

  // ───────────────────────────────────────────────
  // VERIFICAR JANELA DE 24 HORAS (APENAS WHATSAPP)
  // ───────────────────────────────────────────────
  fastify.get('/check-24h/:user_id', async (req, reply) => {
    const { user_id } = req.params;

    try {
      const { rows } = await dbPool.query(`
        SELECT timestamp FROM messages
        WHERE user_id = $1 AND direction = 'incoming'
        ORDER BY timestamp DESC
        LIMIT 1
      `, [user_id]);

      if (!rows.length) {
        return reply.send({ within24h: true, lastIncoming: null });
      }

      const last = new Date(rows[0].timestamp);
      const diffInHours = (Date.now() - last.getTime()) / (1000 * 60 * 60);

      return reply.send({
        within24h: diffInHours <= 24,
        lastIncoming: last.toISOString()
      });
    } catch (error) {
      fastify.log.error('Erro ao verificar janela de 24h:', error);
      return reply.code(500).send({ error: 'Erro ao verificar janela de 24h' });
    }
  });

  // ───────────────────────────────────────────────
  // ATUALIZAÇÃO DE STATUS DE LEITURA (COMUM)
  // ───────────────────────────────────────────────
  fastify.put('/read-status/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    const { last_read } = req.body;

    if (!last_read) {
      return reply.code(400).send({ error: 'last_read é obrigatório' });
    }

    try {
      const { rows } = await dbPool.query(
        `INSERT INTO user_last_read (user_id, last_read)
         VALUES ($1, $2)
         ON CONFLICT (user_id)
         DO UPDATE SET last_read = EXCLUDED.last_read
         RETURNING user_id, last_read;`,
        [user_id, last_read]
      );
      return reply.send(rows[0]);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Erro ao atualizar last_read' });
    }
  });

  // ───────────────────────────────────────────────
  // CONTAGEM DE MENSAGENS NÃO LIDAS (COMUM)
  // ───────────────────────────────────────────────
  fastify.get('/unread-counts', async (req, reply) => {
    try {
      const { rows } = await dbPool.query(`
        SELECT 
          m.user_id,
          COUNT(*) AS unread_count
        FROM messages m
        LEFT JOIN user_last_read r ON m.user_id = r.user_id
        WHERE 
          m.direction = 'incoming'
          AND m.created_at > COALESCE(r.last_read, '1970-01-01')
        GROUP BY m.user_id
      `);
      return reply.send(rows);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Erro ao contar mensagens não lidas' });
    }
  });

  // ───────────────────────────────────────────────
  // ENVIO DE TEMPLATE (APENAS WHATSAPP)
  // ───────────────────────────────────────────────
  fastify.post('/send/template', async (req, reply) => {
    const { to, templateName, languageCode, components } = req.body;
    const userId = `${to}@w.msgcli.net`;

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: components || [],
      },
    };

    try {
      const res = await axios.post(
        `https://graph.facebook.com/${process.env.API_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const whatsappMsgId = res.data.messages?.[0]?.id || null;
      const outgoingMsg = {
        user_id: userId,
        message_id: whatsappMsgId,
        direction: 'outgoing',
        type: 'template',
        content: templateName,
        timestamp: new Date().toISOString(),
        status: 'sent',
        metadata: JSON.stringify({ languageCode, components }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        channel: 'whatsapp',
      };

      const { rows } = await dbPool.query(
        `INSERT INTO messages (
          user_id, message_id, direction, type, content,
          timestamp, status, metadata, created_at, updated_at, channel
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *;`,
        Object.values(outgoingMsg)
      );

      const insertedMessage = rows[0];
      if (fastify.io) {
        fastify.io.emit('new_message', insertedMessage);
        fastify.io.to(`chat-${userId}`).emit('new_message', insertedMessage);
      }

      return reply.code(200).send(res.data);
    } catch (err) {
      fastify.log.error('[send/template] Erro ao enviar template:', err.response?.data || err.message);
      return reply.code(500).send({ error: 'Erro ao enviar template' });
    }
  });

  // ───────────────────────────────────────────────
  // LISTAR MENSAGENS POR USUÁRIO (COMUM)
  // ───────────────────────────────────────────────
  fastify.get('/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    try {
      const { rows } = await dbPool.query(
        `SELECT * FROM messages
         WHERE user_id = $1
         ORDER BY timestamp ASC;`,
        [user_id]
      );
      reply.send(rows);
    } catch (error) {
      reply.code(500).send({ error: 'Failed to fetch messages' });
    }
  });
}
