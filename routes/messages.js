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
  fastify.post('/send', async (req, reply) => {
    const { to, type, content, context } = req.body;
    const userId = `${to}@w.msgcli.net`;

    // 🔍 Verifica última mensagem incoming para controle da janela de 24h
const { rows: lastIncomingRows } = await dbPool.query(`
  SELECT timestamp
  FROM messages
  WHERE user_id = $1
    AND direction = 'incoming'
  ORDER BY timestamp DESC
  LIMIT 1
`, [userId]);

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

    
    try {
      const result = await sendWhatsappMessage({ to, type, content, context });
      const whatsappMsgId = result.messages?.[0]?.id || null;

      const outgoingMsg = {
        user_id:             userId,
        whatsapp_message_id: whatsappMsgId,
        direction:           'outgoing',
        type,
        content:
          type === 'text' && typeof content === 'object' && content.body
            ? content.body
            : JSON.stringify(content),
        timestamp:           new Date().toISOString(),
        flow_id:             null,
        reply_to:            context?.message_id || null,
        status:              'sent',
        metadata:            null,
        created_at:          new Date().toISOString(),
        updated_at:          new Date().toISOString(),
        channel:             'whatsapp',
      };

      const insertQuery = `
        INSERT INTO messages (
          user_id,
          whatsapp_message_id,
          direction,
          type,
          content,
          timestamp,
          flow_id,
          reply_to,
          status,
          metadata,
          created_at,
          updated_at,
          channel
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

      if (fastify.io) {
        fastify.log.info('[messageRoutes] Emitindo new_message (outgoing):', mensagemInserida);
        fastify.io.emit('new_message', mensagemInserida);
        fastify.io.to(`chat-${mensagemInserida.user_id}`).emit('new_message', mensagemInserida);
      }

      return reply.code(200).send(result);
    } catch (err) {
      const errorData = err.response?.data || err.message;
      fastify.log.error('[messageRoutes] Erro ao enviar outgoing WhatsApp:', errorData);

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
        updated_at:          new Date().toISOString(),
        channel:             'whatsapp',
      };

      const { rows: tplRows } = await dbPool.query(
        `
        INSERT INTO messages (
          user_id, whatsapp_message_id, direction, type, content,
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

