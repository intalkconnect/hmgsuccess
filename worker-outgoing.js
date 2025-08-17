import 'dotenv/config';
import amqplib from 'amqplib';
import { dispatchOutgoing } from './services/outgoing/dispatcher.js';

const AMQP_URL       = process.env.AMQP_URL || 'amqp://guest:guest@rabbitmq:5672/';
const QUEUE = process.env.OUTGOING_QUEUE || 'hmg.outgoing';
const PREFETCH       = Number(process.env.PREFETCH || 50);

async function start() {
  const conn = await amqplib.connect(AMQP_URL, { heartbeat: 15 });
  const ch   = await conn.createChannel();
  await ch.assertQueue(QUEUE, { durable: true });
  await ch.prefetch(PREFETCH);

  ch.consume(QUEUE, async (msg) => {
    if (!msg) return;
    let data;
    try { data = JSON.parse(msg.content.toString()); }
    catch (e) { console.error('[workerOut] JSON inválido:', e?.message); ch.nack(msg, false, false); return; }

    console.log('[workerOut] ➜', { channel: data.channel, to: data.to, type: data.type });

    try {
      const res = await dispatchOutgoing(data);

      if (res.ok) {
        ch.ack(msg);
        return;
      }
      if (res.retry) {
        ch.nack(msg, false, true);     // requeue
        return;
      }
      ch.nack(msg, false, false);      // drop
    } catch (e) {
      console.error('[workerOut] erro inesperado no dispatcher:', e);
      // fallback: trate como requeue (se preferir, coloque contador no header)
      ch.nack(msg, false, true);
    }
  }, { noAck: false });

  console.log(`[workerOut] consumindo ${QUEUE}`);
}

start().catch((e) => { console.error('[workerOut] start fail:', e); process.exit(1); });
