// routes/messages.js
import fp from 'fastify-plugin';
import amqplib from 'amqplib';
import { dbPool } from '../services/db.js';
import { v4 as uuidv4 } from 'uuid';

const AMQP_URL = process.env.AMQP_URL || 'amqp://guest:guest@rabbitmq:5672/';
const OUTGOING_QUEUE = process.env.OUTGOING_QUEUE || 'hmg.outcoming';

let amqpConn = null;
let amqpCh = null;

async function ensureAMQP() {
  if (amqpCh) return amqpCh;
  amqpConn = await amqplib.connect(AMQP_URL, { heartbeat: 15 });
  amqpConn.on('close', () => { amqpConn = null; amqpCh = null; });
  amqpCh = await amqpConn.createChannel();
  await amqpCh.assertQueue(OUTGOING_QUEUE, { durable: true });
  return amqpCh;
}

function decodeUserId(param) {
  try { return decodeURIComponent(param); } catch { return param; }
}

// Se o front mandar "5521...@w.msgcli.net", mantemos; se mandar só "5521...", não alteramos aqui.
function normalizeForStore(userId) {
  return String(userId);
}

export default fp(async function messageRoutes(fastify) {
  const io = fastify.io;

  // GET /api/v1/messages/:userId -> lista de mensagens do usuário
  fastify.get('/:userId', async (req, reply) => {
    const userIdParam = decodeUserId(req.params.userId);
    const userId = normalizeForStore(userIdParam);

    const { rows } = await dbPool.query(
      `SELECT * FROM messages WHERE user_id = $1 ORDER BY timestamp ASC`,
      [userId]
    );
    return rows || [];
  });

  // GET /api/v1/messages/check-24h/:userId -> can_send_freeform (WhatsApp)
  fastify.get('/check-24h/:userId', async (req, reply) => {
    const userIdParam = decodeUserId(req.params.userId);
    const userId = normalizeForStore(userIdParam);

    // pega a última mensagem (incoming OU outgoing) para checar janela
    const { rows } = await dbPool.query(
      `SELECT direction, timestamp
         FROM messages
        WHERE user_id = $1
        ORDER BY timestamp DESC
        LIMIT 1`,
      [userId]
    );

    if (!rows.length) return { can_send_freeform: true };

    const lastTs = new Date(rows[0].timestamp).getTime();
    const now = Date.now();
    const diffHours = (now - lastTs) / 36e5;
    // Regra simples: se houve atividade nas últimas 24h, libera texto livre
    return { can_send_freeform: diffHours <= 24 };
  });

  // GET /api/v1/messages/unread-counts -> contagem de não lidas por user_id
  fastify.get('/unread-counts', async (req, reply) => {
    const { rows } = await dbPool.query(
      `SELECT user_id, COUNT(*)::int AS unread
         FROM messages
        WHERE direction = 'incoming' AND (status IS NULL OR status <> 'read')
        GROUP BY user_id`
    );
    // resposta como objeto { user_id: count }
    const out = {};
    for (const r of rows) out[r.user_id] = r.unread;
    return out;
  });

  // GET /api/v1/messages/read-status -> último "read" por user_id (opcional)
  fastify.get('/read-status', async (req, reply) => {
    const { rows } = await dbPool.query(
      `SELECT user_id, MAX(updated_at) AS last_read_at
         FROM messages
        WHERE direction = 'incoming' AND status = 'read'
        GROUP BY user_id`
    );
    const out = {};
    for (const r of rows) out[r.user_id] = r.last_read_at;
    return out;
  });

  // PUT /api/v1/messages/read-status/:userId -> marca mensagens como lidas
  fastify.put('/read-status/:userId', async (req, reply) => {
    const userIdParam = decodeUserId(req.params.userId);
    const userId = normalizeForStore(userIdParam);

    const { rowCount } = await dbPool.query(
      `UPDATE messages
          SET status = 'read', updated_at = NOW()
        WHERE user_id = $1
          AND direction = 'incoming'
          AND (status IS NULL OR status <> 'read')`,
      [userId]
    );
    return { updated: rowCount };
  });

  // POST /api/v1/messages (ou /send) -> publica no Rabbit e grava pending
  fastify.post('/', async (req, reply) => {
    const { channel, to, type, content, context } = req.body || {};
    if (!channel || !to || !type) return reply.code(400).send({ error: 'payload inválido' });

    const tempId = uuidv4();
    const storageUserId = normalizeForStore(to);

    // grava pending (para UI otimista sobreviver a refresh)
    await dbPool.query(
      `INSERT INTO messages (message_id, user_id, type, content, direction, status, channel, timestamp, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'outgoing', 'pending', $5, NOW(), NOW(), NOW())`,
      [tempId, storageUserId, type, typeof content === 'string' ? content : JSON.stringify(content), channel]
    );

    // publica no Rabbit
    const ch = await ensureAMQP();
    ch.sendToQueue(
      OUTGOING_QUEUE,
      Buffer.from(JSON.stringify({ tempId, channel, to: storageUserId, type, content, context })),
      { persistent: true, headers: { 'x-attempts': 0 } }
    );

    // ACK imediato pro front
    return { success: true, enqueued: true, tempId, user_id: storageUserId };
  });
});
