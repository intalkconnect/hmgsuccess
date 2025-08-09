import amqplib from 'amqplib';
import { dbPool } from '../services/db.js';
import { v4 as uuidv4 } from 'uuid';

let channel;
async function getChannel() {
  if (!channel) {
    const conn = await amqplib.connect(process.env.AMQP_URL);
    channel = await conn.createChannel();
    await channel.assertQueue(process.env.OUTGOING_QUEUE || 'hmg.outcoming', { durable: true });
  }
  return channel;
}

export default async function messageRoutes(fastify, opts) {
  fastify.post('/', async (req, reply) => {
    const { channel: chan, to, type, content, context } = req.body;
    const tempId = uuidv4();

    const client = await dbPool.connect();
    await client.query(`
      INSERT INTO messages (message_id, user_id, type, content, direction, status, timestamp)
      VALUES ($1, $2, $3, $4, 'outgoing', 'pending', NOW())
    `, [tempId, to, type, JSON.stringify(content)]);
    client.release();

    const ch = await getChannel();
    ch.sendToQueue(
      process.env.OUTGOING_QUEUE || 'hmg.outcoming',
      Buffer.from(JSON.stringify({ tempId, channel: chan, to, type, content, context })),
      { persistent: true }
    );

    return { status: 'queued', tempId };
  });
}
