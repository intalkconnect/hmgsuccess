// src/routes/messageRoutes.js
import dotenv from 'dotenv';
import { dbPool } from '../services/db.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
  const identity = await import('../utils/identity.js');
  const { normalizeChannel, makeUserId, splitUserId } = identity;
import axios from 'axios';

dotenv.config();

export default async function messageRoutes(fastify, opts) {
  // ───────────────────────────────────────────────
  // ENVIO DE MENSAGENS COMUNS
  // ───────────────────────────────────────────────
  // routes/messageRoutes.js (trecho /send universal)
  fastify.post('/send', async (req, reply) => {
    // 🔎 loga o corpo recebido (sem segredos)
    fastify.log.info({ body: req.body }, '[messages] /send payload');

    let user_id, to, channel, type, content, context;
    try {
      ({ user_id, to, channel, type, content, context } = req.body || {});
    } catch (e) {
      fastify.log.error(e, '[messages] JSON inválido');
      return reply.code(400).send({ error: 'JSON inválido' });
    }

    // ✅ aceitar user_id OU (to + channel). Se não vier channel, assume WhatsApp
    if (!user_id) {
      if (!to) {
        return reply.code(400).send({ error: 'Informe user_id OU to (+ channel opcional)' });
      }
      user_id = makeUserId(String(to), normalizeChannel(channel || '@w.msgcli.net'));
    }

    // validações básicas
    if (!type) return reply.code(400).send({ error: 'type é obrigatório' });
    if (content == null) return reply.code(400).send({ error: 'content é obrigatório' });

    // resolve canal/sufixo
    const { channel: chName, suffix } = splitUserId(user_id);
    if (suffix === '@') {
      // caso bizarro tipo user_id = "undefined"
      return reply.code(400).send({ error: 'user_id inválido' });
    }

    // ⏱️ Regra de 24h só para WhatsApp
    if (chName === 'whatsapp') {
      try {
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
      } catch (e) {
        fastify.log.error({ e, user_id }, '[messages] erro ao checar janela 24h');
        return reply.code(500).send({ error: 'Erro ao validar janela de 24h' });
      }
    }

    // 🚀 Envio para o provedor
    let result;
    try {
      if (type === 'text' && typeof content === 'string') {
        // normaliza string -> { body }
        content = { body: content };
      }
      result = await sendMessage({ user_id, type, content, context });
    } catch (sendErr) {
      fastify.log.error({ sendErr, user_id, type }, '[messages] sendMessage falhou');
      return reply.code(502).send({
        error: 'Falha ao enviar para o provedor',
        details: sendErr?.message || 'erro desconhecido'
      });
    }

    // 🆔 extrai ID da plataforma
    const platformMsgId =
      result?.messages?.[0]?.id ||      // WhatsApp Cloud
      result?.result?.message_id ||     // Telegram (se vier assim)
      result?.message_id ||             // fallback
      null;

    // 🗄️ conteúdo “bonitinho” pra salvar
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
      channel: suffix // sempre sufixo (@w.msgcli.net, @telegram, @webchat)
    };

    // 💾 insere no banco
    try {
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
        fastify.io.emit('new_message', mensagemInserida);
        fastify.io.to(`chat-${mensagemInserida.user_id}`).emit('new_message', mensagemInserida);
      }
    } catch (dbErr) {
      // não derruba o envio pro cliente; só loga
      fastify.log.error({ dbErr, user_id }, '[messages] erro ao gravar outgoing');
    }

    return reply.code(200).send(result);
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



