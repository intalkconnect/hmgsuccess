import axios from 'axios';
import { initDB, dbPool } from '../../../engine/services/db.js';
// emite via HTTP /emit do servidor realtime
import { emitUpdateMessage } from '../../realtime/emitToRoom.js';

const API_VERSION     = process.env.API_VERSION || 'v22.0';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const WA_TOKEN        = process.env.WHATSAPP_TOKEN;

function onlyDigits(s){ return String(s||'').replace(/\D/g, ''); }

function buildPayload({ to, type, content, context }) {
  const base = { messaging_product: 'whatsapp', to: onlyDigits(to), type };
  if (context?.message_id) base.context = { message_id: context.message_id };

  switch (type) {
    case 'text': {
      const body = content?.body;
      if (!body) throw new Error('text.body é obrigatório');
      return { ...base, text: { body } };
    }
    case 'image': {
      const url = content?.url; if (!url) throw new Error('image.url é obrigatório');
      return { ...base, image: { link: url, ...(content?.caption ? { caption: content.caption } : {}) } };
    }
    case 'audio': {
      const url = content?.url; if (!url) throw new Error('audio.url é obrigatório');
      return { ...base, audio: { link: url, ...(content?.voice ? { voice: true } : {}) } };
    }
    case 'video': {
      const url = content?.url; if (!url) throw new Error('video.url é obrigatório');
      return { ...base, video: { link: url, ...(content?.caption ? { caption: content.caption } : {}) } };
    }
    case 'document': {
      const url = content?.url; if (!url) throw new Error('document.url é obrigatório');
      return { ...base, document: { link: url, ...(content?.filename ? { filename: content.filename } : {}) } };
    }
    case 'template': {
      const { templateName, languageCode, components } = content || {};
      if (!templateName || !languageCode) throw new Error('templateName e languageCode obrigatórios');
      return {
        messaging_product: 'whatsapp',
        to: onlyDigits(to),
        type: 'template',
        template: { name: templateName, language: { code: languageCode }, components: components || [] }
      };
    }
    default:
      throw new Error(`Tipo não suportado no WhatsApp: ${type}`);
  }
}

function isFatalWhatsApp(errData) {
  const code = errData?.error?.code;
  const type = errData?.error?.type;
  return code === 190 || type === 'OAuthException'; // token inválido
}

export async function sendViaWhatsApp({ tempId, to, type, content, context, userId }) {
  if (!WA_TOKEN || !PHONE_NUMBER_ID) {
    return { ok: false, retry: false, reason: 'WHATSAPP_TOKEN/PHONE_NUMBER_ID faltando' };
  }

  await initDB();
  const payload = buildPayload({ to, type, content, context });
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  try {
    const { data } = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });

    const platformId = data?.messages?.[0]?.id || null;

    // atualiza DB (status=sent, message_id real)
    await dbPool.query(
      `UPDATE messages
         SET status='sent',
             message_id=COALESCE($1, message_id),
             updated_at=NOW()
       WHERE message_id=$2`,
      [platformId, tempId]
    );

    // 🔔 emite atualização em tempo real (room = userId; evento que o front escuta: update_message)
    await emitUpdateMessage({
      id: platformId || tempId,
      user_id: userId,                   // TEM que ser igual ao room que o front entrou
      direction: 'outgoing',
      status: 'sent',
      content: { text: content?.body || '' },
      timestamp: new Date().toISOString(),
      channel: 'whatsapp'
    });

    return { ok: true, platformId };
  } catch (e) {
    const plat = e?.response?.data;

    // registra erro no DB
    try {
      await dbPool.query(
        `UPDATE messages
           SET status='error',
               metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{error}', to_jsonb($1)),
               updated_at=NOW()
         WHERE message_id=$2`,
        [plat || e?.message, tempId]
      );
    } catch {}

    // 🔔 emite erro em tempo real
    await emitUpdateMessage({
      id: tempId,
      user_id: userId,
      direction: 'outgoing',
      status: 'error',
      content: { text: content?.body || '' },
      error: String(plat || e?.message || 'send_failed'),
      timestamp: new Date().toISOString(),
      channel: 'whatsapp'
    });

    if (isFatalWhatsApp(plat)) {
      return { ok: false, retry: false, reason: plat || e?.message };
    }
    return { ok: false, retry: true, reason: plat || e?.message };
  }
}
