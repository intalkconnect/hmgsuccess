import 'dotenv/config';
import amqplib from 'amqplib';
import { dispatchOutgoing } from './services/outgoing/dispatcher.js';

const AMQP_URL   = process.env.AMQP_URL || 'amqp://guest:guest@rabbitmq:5672/';
const QUEUE      = process.env.OUTGOING_QUEUE || 'hmg.outgoing';
const PREFETCH   = Number(process.env.PREFETCH || 1);            // debug: 1
const RETRY_TTL  = Number(process.env.RETRY_TTL || 15000);       // 15s
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 5);
const RETRY_QUEUE = `${QUEUE}.retry`;
const DLQ        = `${QUEUE}.dlq`;

function getAttempts(msg) {
  return Number(msg.properties.headers?.['x-attempts'] || 0);
}

async function start() {
  const conn = await amqplib.connect(AMQP_URL, { heartbeat: 15 });
  const ch   = await conn.createChannel();

  // fila principal
  await ch.assertQueue(QUEUE, { durable: true });

  // fila de retry (TTL + DLX devolvendo pra principal)
  await ch.assertQueue(RETRY_QUEUE, {
    durable: true,
    arguments: {
      'x-message-ttl': RETRY_TTL,
      'x-dead-letter-exchange': '',            // default exchange
      'x-dead-letter-routing-key': QUEUE,      // volta pra principal
    },
  });

  // DLQ (para desistência definitiva)
  await ch.assertQueue(DLQ, { durable: true });

  await ch.prefetch(PREFETCH);

  ch.consume(QUEUE, async (msg) => {
    if (!msg) return;

    const attempts = getAttempts(msg) + 1;
    let data;
    try {
      data = JSON.parse(msg.content.toString());
    } catch (e) {
      console.error('[workerOut] JSON inválido:', e?.message);
      ch.ack(msg);                // descarta (ou manda pra DLQ)
      return;
    }

    console.log('[workerOut] job', {
      dtag: msg.fields.deliveryTag,
      redelivered: msg.fields.redelivered,
      attempts,
      channel: data.channel, to: data.to, type: data.type,
    });

    try {
      const res = await withTimeout(dispatchOutgoing(data), 30000); // timebox 30s

      if (res?.ok) {
        ch.ack(msg);            // sucesso
        return;
      }

      if (attempts >= MAX_ATTEMPTS) {
        console.warn('[workerOut] MAX_ATTEMPTS atingido → DLQ');
        ch.ack(msg);
        ch.sendToQueue(
          DLQ,
          Buffer.from(JSON.stringify(data)),
          { persistent: true, headers: { ...msg.properties.headers, 'x-attempts': attempts } }
        );
        return;
      }

      // backoff: ACK o original e reprograme via fila retry
      console.warn('[workerOut] retry agendado em', RETRY_TTL, 'ms');
      ch.ack(msg);
      ch.sendToQueue(
        RETRY_QUEUE,
        Buffer.from(JSON.stringify(data)),
        { persistent: true, headers: { ...msg.properties.headers, 'x-attempts': attempts } }
      );

    } catch (e) {
      // erro inesperado: trate como retry agendado
      console.error('[workerOut] erro inesperado:', e?.message || e);
      if (attempts >= MAX_ATTEMPTS) {
        ch.ack(msg);
        ch.sendToQueue(DLQ, Buffer.from(JSON.stringify(data)), {
          persistent: true, headers: { ...msg.properties.headers, 'x-attempts': attempts }
        });
        return;
      }
      ch.ack(msg);
      ch.sendToQueue(RETRY_QUEUE, Buffer.from(JSON.stringify(data)), {
        persistent: true, headers: { ...msg.properties.headers, 'x-attempts': attempts }
      });
    }
  }, { noAck: false });

  console.log(`[workerOut] consumindo ${QUEUE}`);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); },
                 (e) => { clearTimeout(t); reject(e); });
  });
}

start().catch((e) => { console.error('[workerOut] start fail:', e); process.exit(1); });
