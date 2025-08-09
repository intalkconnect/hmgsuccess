// routes/messages.js
import amqplib from 'amqplib';
import { dbPool } from '../services/db.js';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const AMQP_URL  = process.env.AMQP_URL || 'amqp://guest:guest@rabbitmq:5672/';
const QUEUE     = process.env.OUTGOING_QUEUE || 'hmg.outgoing';

let amqpConn = null;
let amqpCh   = null; // ConfirmChannel

function redact(u) {
  return String(u).replace(/(\/\/[^:]+:)([^@]+)(@)/, '$1***$3');
}

async function connectAMQP(fastify) {
  if (amqpCh) return amqpCh;

  fastify.log.info(`[AMQP] connecting → ${redact(AMQP_URL)}`);
  amqpConn = await amqplib.connect(AMQP_URL, { heartbeat: 15, clientProperties: { connection_name: 'api-messages' } });

  amqpConn.on('error', (e) => {
    fastify.log.error({ err: e }, '[AMQP] connection error');
  });
  amqpConn.on('close', () => {
    fastify.log.warn('[AMQP] connection closed');
    amqpConn = null;
    amqpCh = null;
  });
  amqpConn.on('blocked', (reason) => fastify.log.warn('[AMQP] connection BLOCKED:', reason));
  amqpConn.on('unblocked', () => fastify.log.warn('[AMQP] connection UNBLOCKED'));

  // Confirm channel = garante persistência (você pode aguardar confirmação)
  amqpCh = await amqpConn.createConfirmChannel();

  amqpCh.on('error', (e) => {
    fastify.log.error({ err: e }, '[AMQP] channel error');
  });
  amqpCh.on('close', () => {
    fastify.log.warn('[AMQP] channel closed');
    amqpCh = null;
  });

  fastify.log.info('[AMQP] assertQueue', { queue: QUEUE, durable: true });
  await amqpCh.assertQueue(QUEUE, { durable: true });

  fastify.log.info('[AMQP] READY (confirm channel)');
  return amqpCh;
}

async function ensureAMQP(fastify) {
  if (amqpCh) return amqpCh;
  return connectAMQP(fastify);
}

const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// valida igual ao antigo
function validateContent(type, content, channel) {
  if (!type) throw new Error('Message type is required');
  if (type === 'text') {
    const body = content?.body?.toString?.() ?? '';
    if (!body.trim()) throw new Error('Message text cannot be empty');
    return;
  }
  if (!content || !content.url || typeof content.url !== 'string') {
    throw new Error(`Media URL is required for type "${type}" on channel "${channel}"`);
  }
}

function formatUserId(to, channel = 'whatsapp') {
  return channel === 'telegram' ? `${to}@t.msgcli.net` : `${to}@w.msgcli.net`;
}

async function within24h(userId) {
  const { rows } = await dbPool.query(
    `SELECT timestamp
       FROM messages
      WHERE user_id = $1 AND direction = 'incoming'
      ORDER BY timestamp DESC
      LIMIT 1`,
    [userId]
  );
  if (!rows.length) return true;
  const diffH = (Date.now() - new Date(rows[0].timestamp).getTime()) / 36e5;
  return diffH <= 24;
}

export default async function messagesRoutes(fastify) {
  fastify.log.info('[messages] registrando rotas (AMQP queue=%s)', QUEUE);

  // ──────────────────────────────
  // Health AMQP
  // ──────────────────────────────
  fastify.get('/_amqp', async (_req, _reply) => {
    try {
      const ch = await ensureAMQP(fastify);
      const qinfo = await ch.checkQueue(QUEUE);
      return {
        ok: true,
        queue: QUEUE,
        messageCount: qinfo.messageCount,
        consumerCount: qinfo.consumerCount,
        connected: !!amqpConn,
        channel: !!amqpCh,
      };
    } catch (e) {
      fastify.log.error({ err: e }, '[_amqp] fail');
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // ===================== ENVIO =====================

  // POST /api/v1/messages/send
  fastify.post('/send', async (req, reply) => {
    const { to, type, content, context, channel = 'whatsapp' } = req.body || {};
    fastify.log.info({ payload: req.body }, '[messages/send] incoming');

    if (!to || !type) return reply.code(400).send({ error: 'Recipient and type are required' });
    validateContent(type, content, channel);

    const userId = formatUserId(to, channel);

    if (channel === 'whatsapp') {
      const ok = await within24h(userId);
      if (!ok) return reply.code(400).send({ error: 'Outside 24h window. Use an approved template.' });
    }

    const tempId = uuidv4();
    const dbContent = type === 'text' ? content.body : JSON.stringify(content);

    // grava PENDING
    const { rows } = await dbPool.query(
      `INSERT INTO messages (
         user_id, message_id, direction, type, content, timestamp,
         flow_id, reply_to, status, metadata, created_at, updated_at, channel
       ) VALUES ($1,$2,'outgoing',$3,$4,NOW(),
                 NULL, $5, 'pending', NULL, NOW(), NOW(), $6)
       RETURNING *`,
      [userId, tempId, type, dbContent, context?.message_id || null, channel]
    );
    const pending = rows[0];

    // publica no Rabbit
    const payload = {
      tempId,
      channel,
      to,       // cru (sem sufixo)
      userId,   // completo
      type,
      content,
      context
    };
    const body = Buffer.from(JSON.stringify(payload));

    try {
      const ch = await ensureAMQP(fastify);

      const ok = ch.sendToQueue(
        QUEUE,
        body,
        { persistent: true, headers: { 'x-attempts': 0 } }
      );

      fastify.log.info(
        {
          queue: QUEUE,
          tempId,
          bytes: body.length,
          backpressure: ok === false,
          headers: { 'x-attempts': 0 }
        },
        '[messages/send] published'
      );

      // Aguarda confirmação (ConfirmChannel)
      await ch.waitForConfirms();
      fastify.log.info({ tempId }, '[messages/send] broker confirmed');

    } catch (e) {
      fastify.log.error({ err: e, tempId }, '[messages/send] AMQP publish failed');
      // opcional: atualizar status do pending para 'error'
      try {
        await dbPool.query(
          `UPDATE messages SET status='error', updated_at=NOW() WHERE message_id=$1`,
          [tempId]
        );
      } catch {}
      return reply.code(502).send({ error: 'Failed to enqueue', details: e?.message });
    }

    // emite pra UI
    try {
      fastify.io?.to(`chat-${userId}`).emit('new_message', pending);
      fastify.io?.emit('new_message', pending);
    } catch {}

    return reply.send({ success: true, enqueued: true, message: pending, channel });
  });

  // POST /api/v1/messages/send/template
  fastify.post('/send/template', async (req, reply) => {
    const { to, templateName, languageCode, components } = req.body || {};
    if (!to || !templateName || !languageCode) {
      return reply.code(400).send({ error: 'to, templateName, languageCode são obrigatórios' });
    }
    const channel = 'whatsapp';
    const userId = formatUserId(to, channel);
    const tempId = uuidv4();

    // grava PENDING
    const meta = JSON.stringify({ languageCode, components });
    const { rows } = await dbPool.query(
      `INSERT INTO messages (
         user_id, message_id, direction, type, content,
         timestamp, status, metadata, created_at, updated_at, channel
       ) VALUES ($1,$2,'outgoing','template',$3,
                 NOW(),'pending',$4,NOW(),NOW(),$5)
       RETURNING *`,
      [userId, tempId, templateName, meta, channel]
    );
    const pending = rows[0];

    // publica no Rabbit
    const payload = {
      tempId,
      channel: 'whatsapp',
      to,
      type: 'template',
      content: { templateName, languageCode, components }
    };
    const body = Buffer.from(JSON.stringify(payload));

    try {
      const ch = await ensureAMQP(fastify);
      const ok = ch.sendToQueue(QUEUE, body, { persistent: true, headers: { 'x-attempts': 0 } });

      fastify.log.info(
        { queue: QUEUE, tempId, bytes: body.length, backpressure: ok === false },
        '[messages/send/template] published'
      );

      await ch.waitForConfirms();
      fastify.log.info({ tempId }, '[messages/send/template] broker confirmed');

    } catch (e) {
      fastify.log.error({ err: e, tempId }, '[messages/send/template] AMQP publish failed');
      try {
        await dbPool.query(
          `UPDATE messages SET status='error', updated_at=NOW() WHERE message_id=$1`,
          [tempId]
        );
      } catch {}
      return reply.code(502).send({ error: 'Failed to enqueue', details: e?.message });
    }

    try {
      fastify.io?.to(`chat-${userId}`).emit('new_message', pending);
      fastify.io?.emit('new_message', pending);
    } catch {}

    return reply.send({ success: true, enqueued: true, message: pending, channel });
  });

  // ===================== STATUS / CONTAGEM =====================

  fastify.get('/check-24h/:user_id', async (req) => {
    const userId = decode(req.params.user_id);
    const ok = await within24h(userId);
    return { within24h: ok, can_send_freeform: ok };
  });

  fastify.put('/read-status/:user_id', async (req, reply) => {
    const userId = decode(req.params.user_id);
    const { last_read } = req.body || {};
    if (!last_read) return reply.code(400).send({ error: 'last_read é obrigatório' });

    const { rows } = await dbPool.query(
      `INSERT INTO user_last_read (user_id, last_read)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET last_read = EXCLUDED.last_read
       RETURNING user_id, last_read;`,
      [userId, last_read]
    );
    return rows[0];
  });

  fastify.get('/read-status', async () => {
    const { rows } = await dbPool.query(`SELECT user_id, last_read FROM user_last_read`);
    return rows;
  });

  fastify.get('/unread-counts', async () => {
    const { rows } = await dbPool.query(
      `SELECT 
        m.user_id,
        COUNT(*)::int AS unread_count
       FROM messages m
       LEFT JOIN user_last_read r ON m.user_id = r.user_id
       WHERE m.direction = 'incoming'
         AND m.created_at > COALESCE(r.last_read, '1970-01-01')
       GROUP BY m.user_id`
    );
    return rows;
  });

  // ===================== LISTAGEM =====================
  fastify.get('/:user_id', async (req) => {
    const userId = decode(req.params.user_id);
    const { rows } = await dbPool.query(
      `SELECT * FROM messages
        WHERE user_id = $1
        ORDER BY timestamp ASC;`,
      [userId]
    );
    return rows;
  });
}
