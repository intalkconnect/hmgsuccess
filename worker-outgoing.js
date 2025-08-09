// worker-outgoing.js
import 'dotenv/config';
import amqplib from 'amqplib';
import axios from 'axios';
import { initDB, dbPool } from './services/db.js';

const AMQP_URL       = process.env.AMQP_URL || 'amqp://guest:guest@rabbitmq:5672/';
const OUTGOING_QUEUE = process.env.OUTGOING_QUEUE || 'hmg.outcoming';

const API_VERSION    = process.env.API_VERSION || 'v22.0';
const PHONE_NUMBER_ID= process.env.PHONE_NUMBER_ID; // ex: '676286105563493'
const WA_TOKEN       = process.env.WHATSAPP_TOKEN;

function onlyDigits(s){ return String(s||'').replace(/\D/g, ''); }

function buildWhatsAppPayload({ to, type, content, context }) {
  const base = {
    messaging_product: 'whatsapp',
    to: onlyDigits(to),
    type
  };

  if (context?.message_id) base.context = { message_id: context.message_id };

  switch (type) {
    case 'text':
      if (!content?.body) throw new Error('text.body é obrigatório');
      return { ...base, text: { body: content.body } };

    case 'image':
      if (!content?.url) throw new Error('image.url é obrigatório');
      return { ...base, image: { link: content.url, ...(content.caption && { caption: content.caption }) } };

    case 'audio':
      if (!content?.url) throw new Error('audio.url é obrigatório');
      // se for voice note: content.voice === true
      return { ...base, audio: { link: content.url, ...(content.voice ? { voice: true } : {}) } };

    case 'video':
      if (!content?.url) throw new Error('video.url é obrigatório');
      return { ...base, video: { link: content.url, ...(content.caption && { caption: content.caption }) } };

    case 'document':
      if (!content?.url) throw new Error('document.url é obrigatório');
      return { ...base, document: { link: content.url, ...(content.filename && { filename: content.filename }) } };

    case 'template': {
      const { templateName, languageCode, components } = content || {};
      if (!templateName || !languageCode) throw new Error('templateName e languageCode são obrigatórios');
      return {
        messaging_product: 'whatsapp',
        to: onlyDigits(to),
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: components || []
        }
      };
    }

    default:
      throw new Error(`Tipo não suportado no WhatsApp: ${type}`);
  }
}

async function sendWhatsApp(msg) {
  if (!WA_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error('WHATSAPP_TOKEN/PHONE_NUMBER_ID não configurados');
  }
  const payload = buildWhatsAppPayload(msg);

  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
  return res.data;
}

// Atualiza status no DB pelo tempId (message_id temporário salvo pelo app ao enfileirar)
async function updateStatusByTempId(tempId, fields) {
  // fields: { status, message_id?, error? }
  const sets = [];
  const vals = [];
  let i=1;

  if (fields.status != null){ sets.push(`status = $${i++}`); vals.push(fields.status); }
  if (fields.message_id != null){ sets.push(`message_id = $${i++}`); vals.push(fields.message_id); }
  if (fields.error != null){ sets.push(`metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{error}', to_jsonb($${i++}))`); vals.push(fields.error); }
  sets.push(`updated_at = NOW()`);

  vals.push(tempId);
  const sql = `UPDATE messages SET ${sets.join(', ')} WHERE message_id = $${i} RETURNING *;`;
  const { rows } = await dbPool.query(sql, vals);
  return rows[0];
}

async function start() {
  console.log(`[workerOut] iniciando… AMQP=${AMQP_URL} QUEUE=${OUTGOING_QUEUE}`);
  await initDB();
  console.log('[workerOut] Postgres ok');

  const conn = await amqplib.connect(AMQP_URL, { heartbeat: 15 });
  const ch = await conn.createChannel();
  await ch.assertQueue(OUTGOING_QUEUE, { durable: true });
  await ch.prefetch(50);

  ch.consume(OUTGOING_QUEUE, async (msg) => {
    if (!msg) return;
    const attempts = Number((msg.properties.headers || {})['x-attempts'] || 0);
    let data;
    try {
      data = JSON.parse(msg.content.toString());
    } catch (e) {
      console.error('[workerOut] JSON inválido, descartando:', e?.message);
      ch.nack(msg, false, false);
      return;
    }

    const { tempId, channel, to, userId, type, content, context } = data;
    console.log('[workerOut] ➜', { channel, to, type, attempts });

    try {
      let resp;
      switch (channel) {
        case 'whatsapp':
          resp = await sendWhatsApp({ to, type, content, context });
          break;
        case 'telegram':
          // aqui você pode importar seu sender de Telegram e chamar algo equivalente
          // resp = await sendTelegram(...);
          throw new Error('telegram ainda não implementado no workerOut');
        default:
          throw new Error(`Canal não suportado: ${channel}`);
      }

      // pega o id real da plataforma se existir
      const platformId =
        resp?.messages?.[0]?.id ||        // WhatsApp Cloud API
        resp?.result?.message_id || null; // Telegram (exemplo)

      await updateStatusByTempId(tempId, {
        status: 'sent',
        ...(platformId ? { message_id: platformId } : {})
      });

      // se tiver Socket interna (realtime), você pode emitir aqui usando seu socketClient
      // getIO()?.to(`chat-${userId}`).emit('update_message', ...);

      ch.ack(msg);
      console.log('[workerOut] ✅ enviado');
    } catch (e) {
      console.error('[workerOut] 💥 erro:', e?.response?.data || e?.message || e);
      // marca erro no DB (útil p/ UI ver “error”)
      try {
        await updateStatusByTempId(data.tempId, {
          status: 'error',
          error: e?.response?.data || e?.message
        });
      } catch {}

      if (attempts >= 4) {
        console.warn('[workerOut] ⛔ drop após muitas tentativas');
        ch.nack(msg, false, false);
      } else {
        const headers = { ...(msg.properties.headers || {}), 'x-attempts': attempts + 1 };
        ch.nack(msg, false, true); // requeue
        console.log(`[workerOut] 🔁 retry #${attempts + 1}`);
      }
    }
  }, { noAck: false });

  console.log(`[workerOut] consumindo ${OUTGOING_QUEUE}`);
}

start().catch((e) => {
  console.error('[workerOut] start fail:', e);
  process.exit(1);
});
