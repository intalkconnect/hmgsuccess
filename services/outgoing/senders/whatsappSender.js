// services/outgoing/senders/whatsappSender.js
import FormData from 'form-data';
import { ax } from '../../http/ax.js';
import { emitUpdateMessage } from '../../realtime/emitToRoom.js';
import { initDB, dbPool } from '../../../engine/services/db.js';

// ======================= ENVs =======================
const {
  API_VERSION = 'v22.0',
  PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: ACCESS_TOKEN,
  // se "true", tentamos subir a mídia e enviar por {id}; se "false", enviaremos por {link}
  WABA_UPLOAD_MEDIA = 'false',
} = process.env;

// ==================== Guard rails ===================
function assertEnvs() {
  const missing = [];
  if (!API_VERSION) missing.push('API_VERSION');
  if (!PHONE_NUMBER_ID) missing.push('PHONE_NUMBER_ID');
  if (!ACCESS_TOKEN) missing.push('WHATSAPP_TOKEN');
  if (missing.length) {
    throw new Error(`[WABA] Variáveis ausentes: ${missing.join(', ')}`);
  }
}

function normalizeWaTo(to) {
  if (!to) return to;
  // remove sufixo interno tipo "@w.msgcli.net" e mantém só dígitos
  const cleaned = String(to).replace(/@w\.msgcli\.net$/i, '');
  const digits = cleaned.replace(/\D/g, '');
  return digits.replace(/^0+/, '');
}

function isE164(num) {
  return /^\d{7,15}$/.test(num); // regra simples: 7–15 dígitos
}

// ================= Upload de mídia (opcional) =================
async function uploadMediaFromUrl(url, type) {
  const download = await ax.get(url, { responseType: 'stream', timeout: 20000 });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', download.data, 'media');

  const uploadUrl = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/media`;
  const res = await ax.post(uploadUrl, form, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      ...form.getHeaders(),
    },
    timeout: 20000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const mediaId = res?.data?.id;
  if (!mediaId) throw new Error('[WABA] Upload retornou sem id');
  return mediaId;
}

// ============== Normalização de conteúdo por tipo ==============
function coerceContent(type, content) {
  if (typeof content === 'string' && type === 'text') {
    return { body: content };
  }
  const c = { ...(content || {}) };
  if (type === 'text') {
    if (!c.body && c.text) c.body = c.text;
  }
  if (['image', 'audio', 'video', 'document'].includes(type)) {
    if (!c.url && c.link) c.url = c.link;
  }
  return c;
}

// =================== Payload builder ====================
async function buildPayload({ to, type, content, context }) {
  const payload = { messaging_product: 'whatsapp', to, type };
  if (context?.message_id) payload.context = { message_id: context.message_id };

  if (['image', 'audio', 'video', 'document'].includes(type)) {
    if (content.id) {
      payload[type] = { id: content.id };
      if (type === 'audio' && content.voice === true) payload[type].voice = true;
      if (content.caption) payload[type].caption = content.caption;
      if (content.filename && type === 'document') payload[type].filename = content.filename;
      return payload;
    }
    const mediaUrl = content.url;
    if (!mediaUrl) throw new Error(`[WABA] ${type}.url/link é obrigatório`);

    const wantUpload = String(WABA_UPLOAD_MEDIA).toLowerCase() === 'true';
    if (wantUpload) {
      try {
        const mediaId = await uploadMediaFromUrl(mediaUrl, type);
        payload[type] = { id: mediaId };
        if (type === 'audio' && content.voice === true) payload[type].voice = true;
        if (content.caption) payload[type].caption = content.caption;
        if (content.filename && type === 'document') payload[type].filename = content.filename;
        return payload;
      } catch (e) {
        console.warn('[WABA] Upload falhou, caindo para envio por link. Motivo:', e?.message);
      }
    }
    payload[type] = { link: mediaUrl };
    if (type === 'audio' && content.voice === true) payload[type].voice = true;
    if (content.caption) payload[type].caption = content.caption;
    if (content.filename && type === 'document') payload[type].filename = content.filename;
    return payload;
  }

  if (type === 'location') {
    payload[type] = {
      latitude: content.latitude,
      longitude: content.longitude,
      ...(content.name ? { name: content.name } : {}),
      ...(content.address ? { address: content.address } : {}),
    };
    return payload;
  }

  payload[type] = content;
  return payload;
}

// helper para montar um update “rico” e não apagar a mensagem no front
function buildSafeUpdate({ to, tempId, providerId, type, content, status, reason }) {
  const id = tempId || providerId || null;
  const update = {
    id,                     // muitos reducers usam 'id'
    user_id: to,            // usamos 'to' como você pediu
    channel: 'whatsapp',
    message_id: id,
    provider_id: providerId || undefined,
    status,
    direction: 'outgoing',
    type,
  };
  if (reason) update.reason = reason;

  // incluir 'content' para o front não perder o preview
  if (type === 'text') {
    update.content = content?.body ?? content?.text ?? '';
  } else if (['image', 'video', 'document', 'audio', 'location', 'interactive'].includes(type)) {
    // passa o objeto que você já mandou originalmente
    update.content = content || {};
  }
  return update;
}

// ===================== Sender principal ======================
export async function sendViaWhatsApp(job) {
  assertEnvs();
  await initDB();

  const toRaw = job.to || job.userId || job.user_id;
  const to = normalizeWaTo(toRaw);
  const type = String(job.type || 'text').toLowerCase();
  const content = coerceContent(type, job.content || {});
  const context = job.context || undefined;

  if (!isE164(to)) {
    throw new Error(`[WABA] Destinatário inválido: "${toRaw}". Use DDI/DDD apenas dígitos, ex: 5521999998888`);
  }

  const payload = await buildPayload({ to, type, content, context });

  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  try {
    const res = await ax.post(url, payload, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });

    const providerId = res?.data?.messages?.[0]?.id || null;

    // ✅ DB: marca sent e troca tempId -> providerId (se vier)
    try {
      await dbPool.query(
        `UPDATE messages
           SET status='sent',
               message_id=COALESCE($1, message_id),
               updated_at=NOW()
         WHERE message_id=$2`,
        [providerId, job.tempId]
      );
    } catch (dbErr) {
      console.warn('[whatsappSender] aviso ao atualizar DB (sent):', dbErr?.message);
    }

    // 🔔 Update “rico” para não quebrar o renderer no front
    try {
      await emitUpdateMessage(
        buildSafeUpdate({
          to,
          tempId: job.tempId,
          providerId,
          type,
          content,
          status: 'sent',
        })
      );
    } catch {}

    return { ok: true, providerId, response: res.data };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error(`❌ [WABA] Falha ao enviar (status ${status ?? 'N/A'}):`, data?.error || err.message);

    // ❌ DB: marca error e grava metadata
    try {
      await dbPool.query(
        `UPDATE messages
           SET status='error',
               metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{error}', to_jsonb($1)),
               updated_at=NOW()
         WHERE message_id=$2`,
        [data?.error || err.message, job.tempId]
      );
    } catch (dbErr) {
      console.warn('[whatsappSender] aviso ao atualizar DB (error):', dbErr?.message);
    }

    // 🔔 Update “rico” de erro (mantém type/content para o front não perder o card)
    try {
      await emitUpdateMessage(
        buildSafeUpdate({
          to,
          tempId: job.tempId,
          providerId: null,
          type,
          content,
          status: 'failed',
          reason: data?.error?.message || err.message || 'send error',
        })
      );
    } catch {}

    throw err; // Propaga p/ retry/backoff do worker
  }
}
