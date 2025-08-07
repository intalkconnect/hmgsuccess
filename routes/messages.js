// src/routes/messageRoutes.js
import dotenv from 'dotenv';
import axios from 'axios';
import { dbPool } from '../services/db.js';
import { sendMessageByChannel, getChannelByUserId } from '../adapters/messenger.js';

dotenv.config();

export default async function messageRoutes(fastify, opts) {
  // ───────────────────────────────────────────────
  // Helpers internos (identidade / normalização)
  // ───────────────────────────────────────────────
  const normalizeChannel = (raw) => String(raw || '').toLowerCase().trim();

  // Monta user_id no formato "<id>@<channel>"
  const makeUserId = (id, channel) => {
    const ch = normalizeChannel(channel);
    return `${String(id).trim()}@${ch}`;
  };

  // Separa user_id em { id, channel }
  const parseUserId = (userId) => {
    const s = String(userId || '');
    const at = s.lastIndexOf('@');
    if (at === -1) return { id: s, channel: '' };
    return { id: s.slice(0, at), channel: s.slice(at + 1) };
  };

  // Descobre canal a partir do user_id ou função externa
  const inferChannel = (userId, explicitChannel) => {
    if (explicitChannel) return normalizeChannel(explicitChannel);
    if (typeof getChannelByUserId === 'function') {
      const ch = getChannelByUserId(userId);
      if (ch) return normalizeChannel(ch);
    }
    return normalizeChannel(parseUserId(userId).channel || 'whatsapp');
  };

  // Extrai id de mensagem do retorno dos adapters (WA/Telegram)
  const extractChannelMsgId = (channel, result) => {
    const ch = normalizeChannel(channel);
    try {
      if (ch === 'whatsapp') {
        // Graph API
        return result?.messages?.[0]?.id || result?.data?.messages?.[0]?.id || null;
      }
      if (ch === 'telegram') {
        // Bot API
        return (
          result?.data?.result?.message_id ||
          result?.data?.message_id ||
          result?.result?.message_id ||
          result?.message_id ||
          null
        );
      }
      // outros canais: adapte aqui quando integrar
      return null;
    } catch {
      return null;
    }
  };

  // ───────────────────────────────────────────────
  // ENVIO DE MENSAGEM
  // ───────────────────────────────────────────────
  fastify.post('/send', {
    schema: {
      body: {
        type: 'object',
        properties: {
          to: { type: ['string', 'null'] },
          type: { type: 'string' },               // 'text', 'image', etc.
          content: {},                             // livre (depende do tipo)
          context: { type: ['object', 'null'] },   // { message_id? }
          user_id: { type: ['string', 'null'] },   // "<id>@<canal>" (opcional)
          channel: { type: ['string', 'null'] },   // 'whatsapp' | 'telegram'...
        },
        required: ['type', 'content'],
        additionalProperties: true,
      }
    }
  }, async (req, reply) => {
    let { to, type, content, context, user_id, channel } = req.body || {};

    // 1) Se veio user_id, prioriza ele; senão, precisa de "to"
    if (!user_id && !to) {
      return reply.code(400).send({ error: '`to` ou `user_id` é obrigatório' });
    }

    // 2) Normaliza canal / user_id
    //    - Se veio user_id, infere canal a partir dele (ou explicitChannel)
    //    - Se não veio user_id, monta a partir de "to" + canal
    if (user_id) {
      channel = inferChannel(user_id, channel);
      const parsed = parseUserId(user_id);
      // Reconstrói para garantir sufixo correto (ex.: força "@telegram")
      user_id = makeUserId(parsed.id || to, channel);
      to = parsed.id || to; // "to" é sempre id sem sufixo
    } else {
      // Sem user_id → monta com "to"+"channel" (default: whatsapp)
      channel = normalizeChannel(channel || 'whatsapp');
      user_id = makeUserId(to, channel);
    }

    // 3) Regra de 24h (apenas WhatsApp)
    if (channel === 'whatsapp') {
      try {
        const { rows: lastIncomingRows } = await dbPool.query(
          `
            SELECT timestamp
            FROM messages
            WHERE user_id = $1
              AND direction = 'incoming'
            ORDER BY timestamp DESC
            LIMIT 1
          `,
          [user_id]
        );

        if (lastIncomingRows.length > 0) {
          const lastIncomingTime = new Date(lastIncomingRows[0].timestamp);
          const now = new Date();
          const hoursDiff = (now - lastIncomingTime) / (1000 * 60 * 60);
          if (hoursDiff > 24) {
            return reply.code(400).send({
              error: 'Fora da janela de 24h. Envie um template aprovado.'
            });
          }
        }
      } catch (e) {
        req.log.error({ err: e }, '[send] Erro ao checar janela 24h');
        // Não bloqueia por erro de leitura; apenas loga.
      }
    }

    // 4) Disparo via adapter e persistência
    try {
      const result = await sendMessageByChannel(channel, to, type, content, context);

      const canalMsgId = extractChannelMsgId(channel, result);

      // Conteúdo salvo: se "text" com { body }, salva body; senão JSON
      const contentToSave =
        type === 'text' && content && typeof content === 'object' && typeof content.body === 'string'
          ? content.body
          : (typeof content === 'string' ? content : JSON.stringify(content));

      const outgoingMsg = {
        user_id,
        message_id: canalMsgId,
        direction: 'outgoing',
        type,
        content: contentToSave,
        timestamp: new Date().toISOString(),
        flow_id: null,
        reply_to: context?.message_id || null,
        status: 'sent',
        metadata: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        channel,
      };

      const insertQuery = `
        INSERT INTO messages (
          user_id, message_id, direction, type, content,
          timestamp, flow_id, reply_to, status, metadata,
          created_at, updated_at, channel
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13
        )
        RETURNING *;
      `;
      const values = Object.values(outgoingMsg);
      const { rows } = await dbPool.query(insertQuery, values);
      const mensagemInserida = rows[0];

      if (fastify.io && mensagemInserida) {
        fastify.log.info('[messageRoutes] Emitindo new_message (outgoing):', {
          user_id: mensagemInserida.user_id,
          message_id: mensagemInserida.message_id,
          channel: mensagemInserida.channel,
        });
        fastify.io.emit('new_message', mensagemInserida);
        fastify.io.to(`chat-${mensagemInserida.user_id}`).emit('new_message', mensagemInserida);
      }

      return reply.code(200).send(result);
    } catch (err) {
      const errorData = err?.response?.data || err?.message || err;
      fastify.log.error('[messageRoutes] Erro ao enviar outgoing:', errorData);

      // Regra 24h (fora da janela) para WhatsApp (erros vindos do Graph)
      if (
        channel === 'whatsapp' && (
          errorData?.error?.message?.includes?.('outside the allowed window') ||
          errorData?.error?.code === 131047
        )
      ) {
        return reply.code(400).send({
          error: 'Mensagem fora da janela de 24 horas. Envie um template aprovado.',
        });
      }
      return reply.code(500).send({ error: 'Erro ao enviar mensagem' });
    }
  });

  // ───────────────────────────────────────────────
  // VERIFICAR SE ESTÁ DENTRO DA JANELA DE 24 HORAS
  // ───────────────────────────────────────────────
  fastify.get('/check-24h/:user_id', {
    schema: {
      params: {
        type: 'object',
        properties: { user_id: { type: 'string' } },
        required: ['user_id'],
        additionalProperties: false
      }
    }
  }, async (req, reply) => {
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
        return reply.send({ within24h: false, lastIncoming: null });
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
  // ATUALIZAÇÃO DE STATUS DE LEITURA
  // ───────────────────────────────────────────────
  fastify.put('/read-status/:user_id', {
    schema: {
      params: {
        type: 'object',
        properties: { user_id: { type: 'string' } },
        required: ['user_id'],
        additionalProperties: false
      },
      body: {
        type: 'object',
        properties: {
          last_read: { type: 'string', format: 'date-time' }
        },
        required: ['last_read'],
        additionalProperties: false
      }
    }
  }, async (req, reply) => {
    const { user_id } = req.params;
    const { last_read } = req.body;

    try {
      const { rows } = await dbPool.query(
        `
          INSERT INTO user_last_read (user_id, last_read)
          VALUES ($1, $2)
          ON CONFLICT (user_id)
          DO UPDATE SET last_read = EXCLUDED.last_read
          RETURNING user_id, last_read;
        `,
        [user_id, last_read]
      );
      return reply.send(rows[0]);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Erro ao atualizar last_read' });
    }
  });

  fastify.get('/read-status', async (req, reply) => {
    try {
      const { rows } = await dbPool.query(
        `SELECT user_id, last_read FROM user_last_read;`
      );
      return reply.send(rows);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Erro ao buscar last_read' });
    }
  });

  // ───────────────────────────────────────────────
  // CONTAGEM DE MENSAGENS NÃO LIDAS (APENAS INCOMING)
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
  // LISTAR CONVERSAS (última mensagem por user_id)
  // ───────────────────────────────────────────────
  fastify.get('/conversations', async (req, reply) => {
    try {
      const { rows } = await dbPool.query(
        `
          SELECT 
            m.user_id,
            MAX(m.timestamp) AS last_message_at,
            c.name,
            c.phone
          FROM messages m
          LEFT JOIN clientes c ON m.user_id = c.user_id
          GROUP BY m.user_id, c.name, c.phone
          ORDER BY last_message_at DESC;
        `
      );
      return reply.send(rows);
    } catch (error) {
      fastify.log.error('Erro ao listar conversas:', error);
      return reply.code(500).send({ error: 'Erro ao listar conversas' });
    }
  });

  // ───────────────────────────────────────────────
  // ENVIO DE TEMPLATE (WhatsApp)
  // ───────────────────────────────────────────────
  fastify.post('/send/template', {
    schema: {
      body: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          templateName: { type: 'string' },
          languageCode: { type: 'string' },
          components: { type: ['array', 'null'] },
        },
        required: ['to', 'templateName', 'languageCode'],
        additionalProperties: true
      }
    }
  }, async (req, reply) => {
    const { to, templateName, languageCode, components } = req.body;
    const userId = makeUserId(to, 'whatsapp');

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

      const whatsappMsgId = res.data?.messages?.[0]?.id || null;
      const outgoingMsg = {
        user_id:    userId,
        message_id: whatsappMsgId,
        direction:  'outgoing',
        type:       'template',
        content:    templateName,
        timestamp:  new Date().toISOString(),
        flow_id:    null,
        agent_id:   null,
        queue_id:   null,
        status:     'sent',
        metadata:   JSON.stringify({ languageCode, components }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        channel:    'whatsapp',
      };

      await dbPool.query(
        `
          INSERT INTO messages (
            user_id, message_id, direction, type, content,
            timestamp, flow_id, agent_id, queue_id, status,
            metadata, created_at, updated_at, channel
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14
          )
        `,
        Object.values(outgoingMsg)
      );

      if (fastify.io) {
        fastify.io.emit('new_message', outgoingMsg);
        fastify.io.to(`chat-${outgoingMsg.user_id}`).emit('new_message', outgoingMsg);
      }

      return reply.code(200).send(res.data);
    } catch (err) {
      fastify.log.error('[send/template] Erro ao enviar template:', err?.response?.data || err?.message || err);
      return reply.code(500).send({ error: 'Erro ao enviar template' });
    }
  });

  // ───────────────────────────────────────────────
  // LISTAR MENSAGENS POR USUÁRIO
  // ───────────────────────────────────────────────
  fastify.get('/:user_id', {
    schema: {
      params: {
        type: 'object',
        properties: { user_id: { type: 'string' } }, // sem regex, aceita qualquer formato
        required: ['user_id'],
        additionalProperties: false
      }
    }
  }, async (req, reply) => {
    const { user_id } = req.params;
    try {
      const { rows } = await dbPool.query(
        `
          SELECT *
          FROM messages
          WHERE user_id = $1
          ORDER BY timestamp ASC;
        `,
        [user_id]
      );
      return reply.send(rows);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch messages' });
    }
  });
}
