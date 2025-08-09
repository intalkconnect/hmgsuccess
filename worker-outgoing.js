import amqplib from 'amqplib';
import dotenv from 'dotenv';
import { sendMessageByChannel } from './engine/messenger.js';
import { dbPool } from './services/db.js';

dotenv.config();

async function updateStatus(tempId, status, providerId = null) {
  const client = await dbPool.connect();
  await client.query(`
    UPDATE messages
    SET status = $2, provider_message_id = $3, updated_at = NOW()
    WHERE message_id = $1
  `, [tempId, status, providerId]);
  client.release();
}

async function start() {
  const conn = await amqplib.connect(process.env.AMQP_URL);
  const ch = await conn.createChannel();
  const queue = process.env.OUTGOING_QUEUE || 'hmg.outcoming';
  await ch.assertQueue(queue, { durable: true });

  ch.consume(queue, async (msg) => {
    const data = JSON.parse(msg.content.toString());
    try {
      const res = await sendMessageByChannel(data.channel, data.to, data.type, data.content, data.context);
      const providerId = res?.messages?.[0]?.id || null;
      await updateStatus(data.tempId, 'sent', providerId);
    } catch (err) {
      console.error('Erro ao enviar:', err);
      await updateStatus(data.tempId, 'error');
    }
    ch.ack(msg);
  });
}

start().catch(console.error);
