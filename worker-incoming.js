// worker.js
import 'dotenv/config';
import amqplib from 'amqplib';
import crypto from 'crypto';
import { initDB } from './services/db.js';
import { processEvent } from './services/high/processEvent.js';
import { getIO } from './services/realtime/socketClient.js';

const AMQP_URL       = process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672/';
const QUEUE          = process.env.INCOMING_QUEUE || 'hmg.incoming';
const PREFETCH       = Number(process.env.PREFETCH || 50);
const MAX_RETRY      = Number(process.env.MAX_RETRIES || 5);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 0); // 0 = sem delay (a menos que use delayed-exchange)

let conn, ch, closing = false;
const io = getIO();

const now = () => new Date().toISOString();
const redact = (u) => String(u).replace(/(\/\/[^:]+:)([^@]+)(@)/, '$1***$3');
const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);

// === helpers ===============================================================

function getAttempts(msg) {
  return Number((msg.properties.headers || {})['x-attempts'] || 0);
}

async function requeueWithHeader(msg, reason = 'retry') {
  const attempts = getAttempts(msg) + 1;

  // republica a MESMA mensagem com header atualizado
  const headers = { ...(msg.properties.headers || {}), 'x-attempts': attempts };
  const opts = {
    persistent: true,
    contentType: msg.properties.contentType,
    contentEncoding: msg.properties.contentEncoding,
    correlationId: msg.properties.correlationId,
    messageId: msg.properties.messageId,
    headers,
  };

  if (RETRY_DELAY_MS > 0) {
    // delay local simples (não usa plugin). Só atrasa a republicação.
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
  }

  ch.sendToQueue(QUEUE, msg.content, opts);
  ch.ack(msg);

  console.warn(`🔁 requeue #${attempts} (${reason})`);
}

async function nackDrop(msg, reason = 'drop') {
  console.warn(`⛔ drop (no-requeue) — motivo: ${reason}`);
  ch.nack(msg, false, false);
}

// === consumer ==============================================================

async function onMessage(msg) {
  if (!msg) return;
  const attempts = getAttempts(msg);
  const bodyBuf  = msg.content;
  const bodyLen  = bodyBuf?.length || 0;
  const bodyHash = hash(bodyBuf || Buffer.alloc(0));

  let evt;
  try {
    evt = JSON.parse(bodyBuf.toString());
  } catch (e) {
    console.error('❌ JSON inválido — NACK drop:', e?.message);
    return nackDrop(msg, 'json-parse');
  }

  console.log(
    `📦 evento (${now()}) tag=${msg.fields.deliveryTag} attempts=${attempts} ` +
    `bytes=${bodyLen} sha1=${bodyHash} ->`,
    {
      channel: evt?.channel,
      tenant: evt?.tenant_id,
      agg: evt?.aggregate_id,
      ext: evt?.external_id,
      headers: msg.properties.headers || {},
    }
  );

  const t0 = Date.now();
  try {
    const status = await processEvent(evt, { io });
    const dt = Date.now() - t0;

    if (status === 'duplicate') {
      console.log(`♻️ duplicate — ACK (dt=${dt}ms)`);
      ch.ack(msg);
      return;
    }

    ch.ack(msg);
    console.log(`✅ processado — ACK (dt=${dt}ms)`);
  } catch (e) {
    const dt = Date.now() - t0;
    const reason = e?.message || e;
    console.error(`💥 erro no processamento (dt=${dt}ms):`, reason);

    if (attempts + 1 >= MAX_RETRY) {
      return nackDrop(msg, `max-retry(${MAX_RETRY})`);
    }

    // requeue correto com header incrementado
    return requeueWithHeader(msg, reason);
  }
}

// === bootstrap =============================================================

async function start() {
  console.log(`🚀 Worker @ ${now()} | AMQP=${redact(AMQP_URL)} | QUEUE=${QUEUE} | PREFETCH=${PREFETCH} | MAX_RETRY=${MAX_RETRY}`);

  await initDB();
  console.log('🗄️ Postgres conectado');

  conn = await amqplib.connect(AMQP_URL, { heartbeat: 15, clientProperties: { connection_name: 'hmg-incoming-worker' } });

  conn.on('error',  e => console.error('[amqp conn error]', e?.message || e));
  conn.on('close',  () => { console.warn('[amqp conn closed]'); if (!closing) process.exit(1); });
  conn.on('blocked',   (reason) => console.warn('[amqp conn blocked]', reason));
  conn.on('unblocked', () => console.warn('[amqp conn unblocked]'));

  ch = await conn.createChannel();
  ch.on('error', e => console.error('[amqp ch error]', e?.message || e));
  ch.on('close', () => console.warn('[amqp ch closed]'));

  console.log('🪵 assertQueue...');
  await ch.assertQueue(QUEUE, { durable: true });

  console.log('🎚️ prefetch...', PREFETCH);
  await ch.prefetch(PREFETCH);

  // health info
  try {
    const qinfo = await ch.checkQueue(QUEUE);
    console.log('🩺 queue info:', { messageCount: qinfo.messageCount, consumerCount: qinfo.consumerCount });
  } catch (e) {
    console.warn('⚠️ checkQueue falhou:', e?.message || e);
  }

  console.log('👂 iniciando consumo...');
  await ch.consume(QUEUE, onMessage, { noAck: false, consumerTag: `incoming-${process.pid}` });

  console.log(`✅ Consumindo ${QUEUE} (consumerTag=incoming-${process.pid})`);
}

async function shutdown(reason) {
  console.log(`🛑 shutdown: ${reason} @ ${now()}`);
  closing = true;
  try { await ch?.cancel?.(`incoming-${process.pid}`); } catch {}
  try { await ch?.close(); } catch {}
  try { await conn?.close(); } catch {}
  console.log('✅ encerrado');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
process.on('uncaughtException',  e => console.error('uncaughtException', e));

start().catch(e => { console.error('❌ start fail:', e); process.exit(1); });
