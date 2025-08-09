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
const d = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export default fp(async function messagesRoutes(fastify) {
  fastify.log.info('[messages] plugin carregado');

  // --- FIXAS primeiro ---
  fastify.get('/read-status', async () => {
    const { rows } = await dbPool.query(
      `SELECT user_id, MAX(updated_at) AS last_read_at
         FROM messages
        WHERE direction='incoming' AND status='read'
        GROUP BY user_id`
    );
    const out = {}; for (const r of rows) out[r.user_id] = r.last_read_at; return out;
  });

  fastify.get('/unread-counts', async () => {
    const { rows } = await dbPool.query(
      `SELECT user_id, COUNT(*)::int AS unread
         FROM messages
        WHERE direction='incoming' AND (status IS NULL OR status<>'read')
        GROUP BY user_id`
    );
    const out = {}; for (const r of rows) out[r.user_id] = r.unread; return out;
  });

  fastify.put('/read-status/:userId', async (req) => {
    const userId = d(req.params.userId);
    const { rowCount } = await dbPool.query(
      `UPDATE messages
          SET status='read', updated_at=NOW()
        WHERE user_id=$1 AND direction='incoming'
          AND (status IS NULL OR status<>'read')`,
      [userId]
    );
    return { updated: rowCount };
  });

  fastify.get('/check-24h/:userId', async (req) => {
    const userId = d(req.params.userId);
    const { rows } = await dbPool.query(
      `SELECT timestamp FROM messages
        WHERE user_id=$1
        ORDER BY timestamp DESC LIMIT 1`,
      [userId]
    );
    if (!rows.length) return { can_send_freeform: true };
    const diffHours = (Date.now() - new Date(rows[0].timestamp).getTime()) / 36e5;
    return { can_send_freeform: diffHours <= 24 };
  });

  fastify.post('/', async (req, reply) => {
    const { channel, to, type, content, context } = req.body || {};
    if (!channel || !to || !type) return reply.code(400).send({ error: 'payload inválido' });

    const tempId = uuidv4();
    await dbPool.query(
      `INSERT INTO messages (message_id,user_id,type,content,direction,status,channel,timestamp,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'outgoing','pending',$5,NOW(),NOW(),NOW())`,
      [tempId, String(to), type, typeof content==='string'?content:JSON.stringify(content), channel]
    );

    const ch = await ensureAMQP();
    ch.sendToQueue(
      OUTGOING_QUEUE,
      Buffer.from(JSON.stringify({ tempId, channel, to:String(to), type, content, context })),
      { persistent: true, headers: { 'x-attempts': 0 } }
    );

    return { success:true, enqueued:true, tempId, user_id:String(to) };
  });

  // --- DINÂMICA por último ---
  fastify.get('/:userId', async (req) => {
    const userId = d(req.params.userId);
    const { rows } = await dbPool.query(
      `SELECT * FROM messages WHERE user_id=$1 ORDER BY timestamp ASC`,
      [userId]
    );
    return rows || [];
  });
});
