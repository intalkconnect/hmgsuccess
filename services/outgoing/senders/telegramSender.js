import axios from 'axios';
import { initDB, dbPool } from '../../../engine/services/db.js';
import { emitUpdateMessage } from '../../realtime/emitToRoom.js'; // via HTTP /emit

const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_BASE  = TG_TOKEN ? `https://api.telegram.org/bot${TG_TOKEN}` : null;

// 🔑 garante que o update vá para o mesmo "room" que a UI usa
function resolveRoomUserId(userId, to) {
  if (userId && /@t\.msgcli\.net$/i.test(String(userId))) return userId;
  const raw = String(userId || to || '').replace(/@t\.msgcli\.net$/i, '');
  return `${raw}@t.msgcli.net`;
}


function tgFatal(desc = '') {
  const d = String(desc).toLowerCase();
  return (
    d.includes('bot was blocked by the user') ||
    d.includes('user is deactivated') ||
    d.includes('chat not found') ||
    d.includes('bad request: chat not found') ||
    d.includes('message text is empty') ||
    d.includes('wrong http url specified') ||
    d.includes('message is too long') ||
    d.includes('replied message not found')
  );
}

async function tgCall(method, payload) {
  const { data } = await axios.post(`${TG_BASE}/${method}`, payload, { timeout: 15000 });
  if (data?.ok) return data;
  const err = new Error(data?.description || `${method} falhou`);
  err._tg = data;
  throw err;
}

export async function sendViaTelegram({ tempId, to, type, content, context, userId }) {
  if (!TG_BASE) return { ok: false, retry: false, reason: 'TELEGRAM_TOKEN não configurado' };
  await initDB();

  const roomUserId = resolveRoomUserId(userId, to)

  try {
    let data;
    switch (type) {
      case 'text': {
        const text = content?.body;
        if (!text) throw new Error('Telegram: text.body obrigatório');
        data = await tgCall('sendMessage', {
          chat_id: to,
          text,
          ...(context?.message_id ? { reply_to_message_id: context.message_id } : {})
        });
        break;
      }
      case 'image': {
        const photo = content?.url; if (!photo) throw new Error('Telegram: image.url obrigatório');
        data = await tgCall('sendPhoto', {
          chat_id: to,
          photo,
          ...(content?.caption ? { caption: content.caption } : {}),
          ...(context?.message_id ? { reply_to_message_id: context.message_id } : {})
        });
        break;
      }
      case 'audio': {
        const link = content?.url; if (!link) throw new Error('Telegram: audio.url obrigatório');
        const method = content?.voice ? 'sendVoice' : 'sendAudio';
        const field  = content?.voice ? 'voice'     : 'audio';
        data = await tgCall(method, {
          chat_id: to,
          [field]: link,
          ...(content?.caption ? { caption: content.caption } : {}),
          ...(context?.message_id ? { reply_to_message_id: context.message_id } : {})
        });
        break;
      }
      case 'video': {
        const link = content?.url; if (!link) throw new Error('Telegram: video.url obrigatório');
        data = await tgCall('sendVideo', {
          chat_id: to,
          video: link,
          ...(content?.caption ? { caption: content.caption } : {}),
          ...(context?.message_id ? { reply_to_message_id: context.message_id } : {})
        });
        break;
      }
      case 'document': {
        const link = content?.url; if (!link) throw new Error('Telegram: document.url obrigatório');
        data = await tgCall('sendDocument', {
          chat_id: to,
          document: link,
          ...(content?.caption ? { caption: content.caption } : {}),
          ...(context?.message_id ? { reply_to_message_id: context.message_id } : {})
        });
        break;
      }
      case 'location': {
        const lat = Number(content?.latitude), lng = Number(content?.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Telegram: latitude/longitude obrigatórios');
        data = await tgCall('sendLocation', {
          chat_id: to,
          latitude: lat,
          longitude: lng,
          ...(context?.message_id ? { reply_to_message_id: context.message_id } : {})
        });
        break;
      }
      default:
        return { ok: false, retry: false, reason: `Tipo não suportado no Telegram: ${type}` };
    }

    const platformId =
      data?.result?.message_id ||
      (Array.isArray(data?.result) ? data.result[0]?.message_id : null) || null;

    await dbPool.query(
      `UPDATE messages
         SET status='sent',
             message_id=COALESCE($1, message_id),
             updated_at=NOW()
       WHERE message_id=$2`,
      [platformId, tempId]
    );

// ✅ Update "safe": inclui chaves que a UI espera e não apaga o card
    const mid = tempId || platformId || null;
    const safeUpdate = {
      user_id: roomUserId,         // room certo
      channel: 'telegram',
      id: mid,                     // muitos reducers usam 'id'
      message_id: mid,             // também mantém 'message_id'
      provider_id: platformId || undefined,
      status: 'sent',
      direction: 'outgoing',       // preserva direção
      type,                        // preserva tipo p/ preview/sort
      timestamp: new Date().toISOString()
    };
    // só adiciona 'content' quando for realmente útil (evita sobrescrever mídia com vazio)
    if (type === 'text' && content?.body) {
      safeUpdate.content = { body: content.body };
    } else if ((type === 'image' || type === 'video' || type === 'document') &&
               (content?.filename || content?.caption)) {
      safeUpdate.content = {};
      if (content.filename) safeUpdate.content.filename = content.filename;
      if (content.caption)  safeUpdate.content.caption  = content.caption;
    }
    await emitUpdateMessage(safeUpdate);

    return { ok: true, platformId };
  } catch (e) {
    const tg = e?._tg;
    const desc = tg?.description || e?.message || '';

    try {
      await dbPool.query(
        `UPDATE messages
           SET status='error',
               metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{error}', to_jsonb($1)),
               updated_at=NOW()
         WHERE message_id=$2`,
        [tg || e?.message, tempId]
      );
    } catch {}

  // ❌ Update de erro: mantém campos-base para não sumir o card na UI
    const errUpdate = {
      user_id: roomUserId,
      channel: 'telegram',
      id: tempId,
      message_id: tempId,
      status: 'error',
      reason: String(desc || 'send_failed'),
      direction: 'outgoing',
      type,
      timestamp: new Date().toISOString()
    };
    // mesmo critério p/ 'content' do caso de sucesso (opcional)
    if (type === 'text' && content?.body) {
      errUpdate.content = { body: content.body };
    } else if ((type === 'image' || type === 'video' || type === 'document') &&
               (content?.filename || content?.caption)) {
      errUpdate.content = {};
      if (content.filename) errUpdate.content.filename = content.filename;
      if (content.caption)  errUpdate.content.caption  = content.caption;
    }
    await emitUpdateMessage(errUpdate);

    if (tgFatal(desc)) {
      return { ok: false, retry: false, reason: desc };
    }
    return { ok: false, retry: true, reason: desc };
  }
}
