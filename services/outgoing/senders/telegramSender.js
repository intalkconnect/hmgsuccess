// services/outgoing/senders/telegramSender.js
import FormData from 'form-data';
import { spawn } from 'child_process';
import { ax } from '../../http/ax.js';
import { initDB, dbPool } from '../../../engine/services/db.js';
import { emitUpdateMessage } from '../../realtime/emitToRoom.js';

const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_BASE  = TG_TOKEN ? `https://api.telegram.org/bot${TG_TOKEN}` : null;
// habilita transmux WEBM -> OGG/Opus quando voice:true ou link .webm
const TG_TRANSMUX_WEBM = String(process.env.TG_TRANSMUX_WEBM ?? 'true').toLowerCase() === 'true';

// ---------- helpers ----------
const isWebm = (u='') => /\.webm(\?|#|$)/i.test(String(u));
const isOgg  = (u='') => /\.ogg(\?|#|$)/i.test(String(u));

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
  const { data } = await ax.post(`${TG_BASE}/${method}`, payload, { timeout: 15000 });
  if (data?.ok) return data;
  const err = new Error(data?.description || `${method} falhou`);
  err._tg = data;
  throw err;
}

// ffmpeg transmux: WEBM (opus) -> OGG (opus), sem re-encode
function spawnFfmpegWebmToOgg() {
  return spawn('ffmpeg', ['-i', 'pipe:0', '-vn', '-c:a', 'copy', '-f', 'ogg', 'pipe:1'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

// Envia VOICE via multipart stream (rápido, sem escrever em disco)
async function sendVoiceMultipartFromUrl({ chat_id, url, caption, reply_to_message_id }) {
  const resp = await ax.get(url, { responseType: 'stream', timeout: 20000 });

  let stream = resp.data;
  let filename = 'voice.ogg';

  const contentType = String(resp.headers['content-type'] || '');
  const isWebmStream = isWebm(url) || /webm/i.test(contentType);

  if (isWebmStream) {
    if (!TG_TRANSMUX_WEBM) throw new Error('[TG] WEBM detectado e TG_TRANSMUX_WEBM=false');
    const ff = spawnFfmpegWebmToOgg();
    stream.pipe(ff.stdin);
    stream = ff.stdout;
  } else if (!isOgg(url) && !/ogg|opus/i.test(contentType)) {
    // Telegram voice exige ogg/opus
    throw new Error('[TG] Formato não suportado para voice (precisa ser ogg/opus)');
  }

  const form = new FormData();
  form.append('chat_id', String(chat_id));
  form.append('voice', stream, filename);
  if (caption) form.append('caption', caption);
  if (reply_to_message_id) form.append('reply_to_message_id', String(reply_to_message_id));

  const { data } = await ax.post(`${TG_BASE}/sendVoice`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 30000,
  });

  if (data?.ok) return data;
  const err = new Error(data?.description || 'sendVoice falhou');
  err._tg = data;
  throw err;
}

// ============= SENDER PRINCIPAL =============
export async function sendViaTelegram({ tempId, to, type, content, context }) {
  if (!TG_BASE) return { ok: false, retry: false, reason: 'TELEGRAM_TOKEN não configurado' };
  await initDB();

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
        const photo = content?.url;
        if (!photo) throw new Error('Telegram: image.url obrigatório');
        data = await tgCall('sendPhoto', {
          chat_id: to,
          photo,
          ...(content?.caption ? { caption: content.caption } : {}),
          ...(context?.message_id ? { reply_to_message_id: context.message_id } : {})
        });
        break;
      }

      case 'audio': {
        const link = content?.url;
        if (!link) throw new Error('Telegram: audio.url obrigatório');

        // voice:true ou .webm => enviar como VOICE (ogg/opus), transmuxando se necessário
        if (content?.voice === true || isWebm(link)) {
          try {
            data = await sendVoiceMultipartFromUrl({
              chat_id: to,
              url: link,
              caption: content?.caption,
              reply_to_message_id: context?.message_id
            });
          } catch (_) {
            // fallback: envia como documento
            data = await tgCall('sendDocument', {
              chat_id: to,
              document: link,
              ...(content?.caption ? { caption: content.caption } : {}),
              ...(context?.message_id ? { reply_to_message_id: context.message_id } : {})
            });
          }
        } else {
          // áudio comum (mp3/m4a/ogg) por URL
          data = await tgCall('sendAudio', {
            chat_id: to,
            audio: link,
            ...(content?.caption ? { caption: content.caption } : {}),
            ...(context?.message_id ? { reply_to_message_id: context.message_id } : {})
          });
        }
        break;
      }

      case 'video': {
        const link = content?.url;
        if (!link) throw new Error('Telegram: video.url obrigatório');
        data = await tgCall('sendVideo', {
          chat_id: to,
          video: link,
          ...(content?.caption ? { caption: content.caption } : {}),
          ...(context?.message_id ? { reply_to_message_id: context.message_id } : {})
        });
        break;
      }

      case 'document': {
        const link = content?.url;
        if (!link) throw new Error('Telegram: document.url obrigatório');
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
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          throw new Error('Telegram: latitude/longitude obrigatórios');
        }
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

    // extrai o id da mensagem criada no Telegram
    const platformId =
      data?.result?.message_id ||
      (Array.isArray(data?.result) ? data.result[0]?.message_id : null) ||
      null;

    // marca a mensagem como enviada no banco
    await dbPool.query(
      `UPDATE messages
         SET status='sent',
             message_id=COALESCE($1, message_id),
             updated_at=NOW()
       WHERE message_id=$2`,
      [platformId, tempId]
    );

    // 🔔 update_message — EXATAMENTE como estava
    await emitUpdateMessage({
      user_id: to,
      channel: 'telegram',
      message_id: tempId || platformId || null,
      provider_id: platformId || undefined,
      status: 'sent'
    });

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

    // 🔔 update_message — EXATAMENTE como estava (erro)
    await emitUpdateMessage({
      user_id: to,
      channel: 'telegram',
      message_id: tempId || null,
      status: 'failed',
      reason: String(desc || 'send_failed')
    });

    if (tgFatal(desc)) {
      return { ok: false, retry: false, reason: desc };
    }
    return { ok: false, retry: true, reason: desc };
  }
}
