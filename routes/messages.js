// src/routes/messageRoutes.js
import dotenv from 'dotenv';
import { dbPool } from '../services/db.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
import { sendTelegramMessage } from '../services/sendTelegramMessage.js';
import axios from 'axios';

dotenv.config();

/**
 * Valida o conteúdo conforme o tipo e canal.
 * - text: exige content.body não vazio
 * - mídia: exige content.url; caption/filename opcionais
 */
function validateContent(type, content, channel) {
  if (!type) throw new Error('Message type is required');

  if (type === 'text') {
    if (!content || typeof content.body !== 'string' || !content.body.trim()) {
      throw new Error('Message text cannot be empty');
    }
    return;
  }

  // Para mídia (image, audio, video, document...)
  if (!content || !content.url || typeof content.url !== 'string') {
    throw new Error(`Media URL is required for type "${type}" on channel "${channel}"`);
  }
}

export default async function messageRoutes(fastify, opts) {
  // Helper para formatar o userId baseado no canal
  const formatUserId = (to, channel) => {
    return channel === 'telegram'
      ? `${to}@t.msgcli.net`
      : `${to}@w.msgcli.net`;
  };

  // Helper para verificar janela de 24h
  const check24hWindow = async (userId) => {
    const { rows } = await dbPool.query(
      `
      SELECT timestamp FROM messages
      WHERE user_id = $1 AND direction = 'incoming'
      ORDER BY timestamp DESC
      LIMIT 1
    `,
      [userId]
    );

    if (!rows.length) return true; // Sem mensagens anteriores, permite envio

    const last = new Date(rows[0].timestamp);
    const diffInHours = (Date.now() - last.getTime()) / (1000 * 60 * 60);
    return diffInHours <= 24;
  };

  // ───────────────────────────────────────────────
  // ENVIO DE MENSAGENS COMUNS (MULTICANAL)
  // ───────────────────────────────────────────────
  fastify.post('/send', async (req, reply) => {
    const { to, type, content, context, channel = 'whatsapp' } = req.body || {};

    // Log do payload recebido
    fastify.log.info(
      { body: req.body },
      `[/messages/send] Incoming payload (channel=${channel})`
    );

    try {
      // Validate input básico
      if (!to || typeof to !== 'string') {
        throw new Error('Recipient is required');
      }
      if (!type || typeof type !== 'string') {
        throw new Error('Message type is required');
      }

      validateContent(type, content, channel);

      const userId = formatUserId(to, channel);

      // Check 24h window only for WhatsApp
      if (channel === 'whatsapp') {
        const { rows } = await dbPool.query(
          `SELECT timestamp FROM messages 
           WHERE user_id = $1 AND direction = 'incoming'
           ORDER BY timestamp DESC LIMIT 1`,
          [userId]
        );

        if (rows.length > 0) {
          const lastMsgTime = new Date(rows[0].timestamp);
          const hoursDiff = (Date.now() - lastMsgTime.getTime()) / (1000 * 60 * 60);
          if (hoursDiff > 24) {
            return reply.code(400).send({
              error: 'Outside 24h window. Use an approved template.',
            });
          }
        }
      }

      // Send message
      let result;
      let messageId;

      if (channel === 'telegram') {
        // Telegram formatting
        const telegramContent =
          type === 'text'
            ? content.body // string
            : {
                url: content.url,
                ...(content.caption && { caption: content.caption }),
                ...(content.filename && { filename: content.filename }),
              };

        fastify.log.info(
          { to, type, telegramContent },
          '[/messages/send] Sending Telegram'
        );

        result = await sendTelegramMessage({
          chatId: to,
          type,
          content: telegramContent,
        });

        // adapte conforme o retorno real do seu sender
        messageId = result?.message_id || result?.result?.message_id || null;
      } else {
        // WhatsApp formatting
        const whatsappContent =
          type === 'text'
            ? { body: content.body }
            : {
                url: content.url,
                ...(content.caption && { caption: content.caption }),
                ...(content.filename && { filename: content.filename }),
              };

        fastify.log.info(
          { to, type, whatsappContent, context },
          '[/messages/send] Sending WhatsApp'
        );

        result = await sendWhatsappMessage({
          to,
          type,
          content: whatsappContent,
          context,
        });

        messageId = result?.messages?.[0]?.id || null;
      }

      // Save to database
      const dbContent = type === 'text' ? content.body : JSON.stringify(content);

      const insertValues = [
        userId,
        messageId,
        'outgoing',
        type,
        dbContent,
        new Date().toISOString(),
        null, // flow_id
        context?.message_id || null, // reply_to
        'sent',
        null, // metadata
        new Date().toISOString(),
        new Date().toISOString(),
        channel,
      ];

      const { rows: insertedRows } = await dbPool.query(
        `INSERT INTO messages (
          user_id, message_id, direction, type, content,
          timestamp, flow_id, reply_to, status, metadata,
          created_at, updated_at, channel
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        insertValues
      );

      const savedMessage = insertedRows[0];

      // Broadcast via Socket.IO if available
      if (fastify.io) {
        fastify.io.emit('new_message', savedMessage);
        fastify.io.to(`chat-${userId}`).emit('new_message', savedMessage);
      }

      fastify.log.info(
        { savedMessageId: savedMessage?.id, messageId, channel },
        '[/messages/send] Message saved and broadcasted'
      );

      return reply.send({
        success: true,
        message: savedMessage,
        channel,
      });
    } catch (error) {
      // Log detalhado do erro
      fastify.log.error(
        {
          err: error,
          stack: error?.stack,
          body: req.body,
          platform_error: error?.response?.data,
        },
        `Message sending failed (${channel})`
      );

      const errorResponse = {
        error: 'Message sending failed',
        details: error?.message,
        stack: error?.stack,
        channel,
      };

      // Specific error handling
      if (error?.response?.data) {
        errorResponse.platform_error = error.response.data;

        // WhatsApp specific errors
        if (channel === 'whatsapp') {
          const code = error.response.data?.error?.code;
          if (code === 131047) {
            errorResponse.error = 'Message outside 24h window';
          }
          if (code === 131030) {
            errorResponse.error = 'Recipient not in allowed list';
          }
        }

        // Telegram specific errors
        if (channel === 'telegram') {
          const desc = error.response.data?.description || '';
          if (typeof desc === 'string' && desc.includes('message text is empty')) {
            errorResponse.error = 'Message text cannot be empty';
          }
        }
      }

      return reply.code(500).send(errorResponse);
    }
  });

  // ───────────────────────────────────────────────
  // VERIFICAR JANELA DE 24 HORAS (APENAS WHATSAPP)
  // ───────────────────────────────────────────────
  fastify.get('/check-24h/:user_id', async (req, reply) => {
    const { user_id } = req.params;

    try {
      const { rows } = await dbPool.query(
        `
        SELECT timestamp FROM messages
        WHERE user_id = $1 AND direction = 'incoming'
        ORDER BY timestamp DESC
        LIMIT 1
      `,
        [user_id]
      );

      if (!rows.length) {
        return reply.send({ within24h: true, lastIncoming: null });
      }

      const last = new Date(rows[0].timestamp);
      const diffInHours = (Date.now() - last.getTime()) / (1000 * 60 * 60);

      return reply.send({
        within24h: diffInHours <= 24,
        lastIncoming: last.toISOString(),
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
      const { rows } = await dbPool.query(
        `
        SELECT 
          m.user_id,
          COUNT(*) AS unread_count
        FROM messages m
        LEFT JOIN user_last_read r ON m.user_id = r.user_id
        WHERE 
          m.direction = 'incoming'
          AND m.created_at > COALESCE(r.last_read, '1970-01-01')
        GROUP BY m.user_id
      `
      );
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
      fastify.log.info(
        { to, templateName, languageCode },
        '[/messages/send/template] Sending template'
      );

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

      const whatsappMsgId = res.data?.messages?.[0]?.id || null;
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
      fastify.log.error(
        {
          err,
          stack: err?.stack,
          platform_error: err?.response?.data,
          payload,
        },
        '[send/template] Erro ao enviar template'
      );
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
      fastify.log.error({ err: error, stack: error?.stack }, '[/messages/:user_id] Failed to fetch messages');
      reply.code(500).send({ error: 'Failed to fetch messages' });
    }
  });
}
