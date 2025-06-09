import dotenv from 'dotenv'
import { dbPool } from '../services/db.js'
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js'
import axios from 'axios'

dotenv.config()

export default async function messageRoutes(fastify, opts) {
  // ──────────────────────────────────────────────────────────────────────────
  // 1) ENVIA QUALQUER TIPO (TEXT, IMAGE, AUDIO, LOCATION, INTERACTIVE etc)
  // ──────────────────────────────────────────────────────────────────────────
  fastify.post('/send', async (req, reply) => {
    const { to, type, content, context } = req.body
    const userId = `${to}@w.msgcli.net`

    try {
      // Envia a mensagem via WhatsApp
      const result = await sendWhatsappMessage({ to, type, content, context })
      const whatsappMsgId = result.messages?.[0]?.id || null

      // Prepara objeto para inserir
      const outgoingMsg = {
        user_id: userId,
        whatsapp_message_id: whatsappMsgId,
        direction: 'outgoing',
        type,
        content: type === 'text' && typeof content === 'object' && content.body
          ? content.body
          : JSON.stringify(content),
        timestamp: new Date().toISOString(),
        flow_id: null,
        reply_to: context?.message_id || null,
        status: 'sent',
        metadata: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        channel: 'whatsapp'
      }

      // Grava no banco (PostgreSQL)
      const query = `
        INSERT INTO messages(
          user_id, whatsapp_message_id, direction, type, content,
          timestamp, flow_id, reply_to, status, metadata,
          created_at, updated_at, channel
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13
        ) RETURNING *
      `;
      
      const values = [
        outgoingMsg.user_id,
        outgoingMsg.whatsapp_message_id,
        outgoingMsg.direction,
        outgoingMsg.type,
        outgoingMsg.content,
        outgoingMsg.timestamp,
        outgoingMsg.flow_id,
        outgoingMsg.reply_to,
        outgoingMsg.status,
        outgoingMsg.metadata,
        outgoingMsg.created_at,
        outgoingMsg.updated_at,
        outgoingMsg.channel
      ];

      const { rows } = await dbPool.query(query, values);
      const mensagemInserida = rows[0];

      // Emite evento via Socket.IO
      if (fastify.io) {
        fastify.log.info('[messageRoutes] Emitindo new_message (outgoing) via Socket.IO:', mensagemInserida);
        fastify.io.emit('new_message', mensagemInserida);
        fastify.io.to(`chat-${mensagemInserida.user_id}`).emit('new_message', mensagemInserida);
      }

      return reply.code(200).send(result);
    } catch (err) {
      const errorData = err.response?.data || err.message;
      fastify.log.error('[messageRoutes] Erro ao enviar outgoing WhatsApp:', errorData);

      if (
        errorData?.error?.message?.includes('outside the allowed window') ||
        errorData?.error?.code === 131047
      ) {
        return reply.code(400).send({
          error: 'Mensagem fora da janela de 24 horas. Envie um template aprovado.'
        });
      }

      return reply.code(500).send({ error: 'Erro ao enviar mensagem' });
    }
  });

  fastify.get('/', async (req, reply) => {
  const { user_id } = req.query;
  
  try {
    const { rows } = await dbPool.query(
      `SELECT * FROM messages 
       WHERE user_id = $1 
       ORDER BY timestamp ASC`,
      [user_id]
    );
    reply.send(rows);
  } catch (error) {
    reply.code(500).send({ error: 'Failed to fetch messages' });
  }
});

  // Rota para contagem de mensagens não lidas
fastify.put('/read-status/:user_id', async (req, reply) => {
  const { user_id } = req.params;
  const { last_read } = req.body;

  if (!last_read) {
    return reply.code(400).send({ error: 'last_read é obrigatório' });
  }

  try {
    const { rows } = await dbPool.query(`
      INSERT INTO user_last_read (user_id, last_read)
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET last_read = EXCLUDED.last_read
      RETURNING user_id, last_read
    `, [user_id, last_read]);

    return reply.send(rows[0]); // igual supabase: { user_id, last_read }
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: 'Erro ao atualizar last_read' });
  }
});


fastify.get('/read-status', async (req, reply) => {
  try {
    const { rows } = await dbPool.query(`
      SELECT user_id, last_read FROM user_last_read
    `);
    return reply.send(rows); // [{ user_id, last_read }, ...]
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: 'Erro ao buscar last_read' });
  }
});


fastify.get('/unread-counts', async (req, reply) => {
  try {
    const { rows } = await dbPool.query(`
      SELECT 
        m.user_id,
        COUNT(*) AS unread_count
      FROM mensagens m
      LEFT JOIN user_last_read r ON m.user_id = r.user_id
      WHERE m.created_at > COALESCE(r.last_read, '1970-01-01')
      GROUP BY m.user_id
    `);

    return reply.send(rows); // [{ user_id, unread_count }, ...]
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ error: 'Erro ao contar mensagens não lidas' });
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
        name: templateName,
        language: { code: languageCode },
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

      const outgoingMsg = {
        user_id: userId,
        whatsapp_message_id: whatsappMsgId,
        direction: 'outgoing',
        type: 'template',
        content: templateName,
        timestamp: new Date().toISOString(),
        flow_id: null,
        agent_id: null,
        queue_id: null,
        status: 'sent',
        metadata: JSON.stringify({ languageCode, components }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        channel: 'whatsapp'
      };

      // Query para PostgreSQL
      const query = `
        INSERT INTO messages(
          user_id, whatsapp_message_id, direction, type, content,
          timestamp, flow_id, agent_id, queue_id, status,
          metadata, created_at, updated_at, channel
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14
        ) RETURNING *
      `;
      
      const values = [
        outgoingMsg.user_id,
        outgoingMsg.whatsapp_message_id,
        outgoingMsg.direction,
        outgoingMsg.type,
        outgoingMsg.content,
        outgoingMsg.timestamp,
        outgoingMsg.flow_id,
        outgoingMsg.agent_id,
        outgoingMsg.queue_id,
        outgoingMsg.status,
        outgoingMsg.metadata,
        outgoingMsg.created_at,
        outgoingMsg.updated_at,
        outgoingMsg.channel
      ];

      const { rows } = await dbPool.query(query, values);
      const mensagemInserida = rows[0];

      // Emite evento via Socket.IO
      if (fastify.io) {
        fastify.log.info('[messageRoutes] Emitindo new_message (template) via Socket.IO:', mensagemInserida);
        fastify.io.emit('new_message', mensagemInserida);
        fastify.io.to(`chat-${mensagemInserida.user_id}`).emit('new_message', mensagemInserida);
      }

      return reply.code(200).send(res.data);
    } catch (err) {
      fastify.log.error('[messageRoutes] Erro ao enviar template:', err.response?.data || err.message);
      return reply.code(500).send({ error: 'Erro ao enviar template' });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3) LISTA TEMPLATES (não alterado pois não usa banco de dados)
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
      fastify.log.error('[messageRoutes] Erro ao listar templates:', err.response?.data || err.message);
      return reply.code(500).send({ error: 'Erro ao listar templates' });
    }
  });
}
