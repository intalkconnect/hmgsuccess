// src/routes/messageRoutes.js
import dotenv from 'dotenv';
import { dbPool } from '../services/db.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
import axios from 'axios';

dotenv.config();

export default async function messageRoutes(fastify, opts) {
  // ───────────────────────────────────────────────
  // ENVIO DE MENSAGENS COMUNS
  // ───────────────────────────────────────────────
  // routes/messageRoutes.js (trecho /send universal)
  fastify.post('/send', async (req, reply) => {
    try {
      let { user_id, to, channel, type, content, context } = req.body || {};

      // 🔎 Identidade: aceita user_id OU (to + channel)
      if (!user_id) {
        if (!to || !channel) {
          return reply.code(400).send({ error: 'Informe user_id OU to+channel' });
        }
        user_id = makeUserId(String(to), normalizeChannel(channel));
      }

      if (!type) return reply.code(400).send({ error: 'type é obrigatório' });
      if (content == null) return reply.code(400).send({ error: 'content é obrigatório' });

      const { channel: chName, suffix } = splitUserId(user_id);

      // ⏱️ Regra de 24h apenas para WhatsApp
      if (chName === 'whatsapp') {
        const { rows } = await dbPool.query(
          `
          SELECT timestamp
          FROM messages
          WHERE user_id = $1 AND direction = 'incoming'
          ORDER BY timestamp DESC
          LIMIT 1
        `,
          [user_id]
        );

        if (rows.length) {
          const hours = (Date.now() - new Date(rows[0].timestamp).getTime()) / 36e5;
          if (hours > 24) {
            return reply.code(400).send({
              error: 'Fora da janela de 24h. Envie um template aprovado.'
            });
          }
        }
      }

      // 🚀 Envia via roteador único (decide pelo sufixo do user_id)
      const result = await sendMessage({ user_id, type, content, context });

      // 🆔 Tenta capturar o ID da plataforma (WA/Telegram)
      const platformMsgId =
        result?.messages?.[0]?.id ||      // WhatsApp Cloud
        result?.result?.message_id ||     // Telegram (payload padrão)
        result?.message_id ||             // fallback
        null;

      // 🗄️ Normaliza "content" para gravação (preferir texto cru em text)
      const storedContent =
        type === 'text'
          ? (typeof content === 'object' ? (content.body ?? JSON.stringify(content)) : String(content))
          : (typeof content === 'string' ? content : JSON.stringify(content));

      const outgoingMsg = {
        user_id,
        message_id: platformMsgId,
        direction: 'outgoing',
        type,
        content: storedContent,
        timestamp: new Date().toISOString(),
        flow_id: null,
        reply_to: context?.message_id || null,
        status: 'sent',
        metadata: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        channel: suffix, // 👈 sempre grava o sufixo (@w.msgcli.net, @telegram, @webchat)
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
      const { rows: [mensagemInserida] } = await dbPool.query(insertQuery, Object.values(outgoingMsg));

      if (fastify.io && mensagemInserida) {
        fastify.log.info('[messageRoutes] Emitindo new_message (outgoing):', mensagemInserida);
        fastify.io.emit('new_message', mensagemInserida);
        fastify.io.to(`chat-${mensagemInserida.user_id}`).emit('new_message', mensagemInserida);
      }

      return reply.code(200).send(result);
    } catch (err) {
      const errorData = err?.response?.data || err?.message || err;
      fastify.log.error('[messageRoutes] Erro ao enviar outgoing:', errorData);

      // Mensagens fora da janela (retorno típico do WhatsApp Cloud)
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



  // ───────────────────────────────────────────────
// VERIFICAR SE ESTÁ DENTRO DA JANELA DE 24 HORAS
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
  fastify.put('/read-status/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    const { last_read } = req.body;

    if (!last_read) {
      return reply.code(400).send({ error: 'last_read é obrigatório' });
    }

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
      const { rows } = await dbPool.query(`
        SELECT user_id, last_read
        FROM user_last_read;
      `);
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


  fastify.get('/conversations', async (req, reply) => {
    try {
      const { rows } = await dbPool.query(`
        SELECT 
          m.user_id,
          MAX(m.timestamp) AS last_message_at,
          c.name,
          c.phone
        FROM messages m
        LEFT JOIN clientes c ON m.user_id = c.user_id
        GROUP BY m.user_id, c.name, c.phone
        ORDER BY last_message_at DESC;
      `);
      return reply.send(rows);
    } catch (error) {
      fastify.log.error('Erro ao listar conversas:', error);
      return reply.code(500).send({ error: 'Erro ao listar conversas' });
    }
  });

  // ───────────────────────────────────────────────
  // ENVIO DE TEMPLATE
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
        user_id:             userId,
        message_id: whatsappMsgId,
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
        updated_at:          new Date().toISOString(),
        channel:             'whatsapp',
      };

      const { rows: tplRows } = await dbPool.query(
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
        RETURNING *;
      `,
        Object.values(outgoingMsg)
      );

      const mensagemInserida = tplRows[0];
      if (fastify.io) {
        fastify.io.emit('new_message', mensagemInserida);
        fastify.io.to(`chat-${mensagemInserida.user_id}`).emit('new_message', mensagemInserida);
      }

      return reply.code(200).send(res.data);
    } catch (err) {
      fastify.log.error('[send/template] Erro ao enviar template:', err.response?.data || err.message);
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
        properties: {
          user_id: { type: 'string', pattern: '^[^@]+@[^@]+\\.[^@]+$' },
        },
        required: ['user_id'],
      },
    },
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
      reply.send(rows);
    } catch (error) {
      reply.code(500).send({ error: 'Failed to fetch messages' });
    }
  });
}


