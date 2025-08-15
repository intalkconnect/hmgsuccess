import FormData from 'form-data';
import { ax } from '../../http/ax.js';
import { emitUpdateMessage } from '../../realtime/emitToRoom.js';
import { initDB, dbPool } from '../../../engine/services/db.js';

// ======================= ENVs =======================
const {
  API_VERSION = 'v22.0',
  PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: ACCESS_TOKEN,
  WABA_UPLOAD_MEDIA = 'false',
} = process.env;

// ==================== Guard rails ===================
function assertEnvs() {
  const missing = [];
  if (!API_VERSION) missing.push('API_VERSION');
  if (!PHONE_NUMBER_ID) missing.push('PHONE_NUMBER_ID');
  if (!ACCESS_TOKEN) missing.push('WHATSAPP_TOKEN');
  if (missing.length) throw new Error(`[WABA] Variáveis ausentes: ${missing.join(', ')}`);
}

function normalizeWaTo(to) {
  if (!to) return to;
  const cleaned = String(to).replace(/@w\.msgcli\.net$/i, '');
  const digits = cleaned.replace(/\D/g, '');
  return digits.replace(/^0+/, '');
}
function isE164(num) { return /^\d{7,15}$/.test(num); }

// ================= Upload de mídia (opcional) =================
async function uploadMediaFromUrl(url) {
  const download = await ax.get(url, { responseType: 'stream', timeout: 20000 });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', download.data, 'media');

  const uploadUrl = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/media`;
  const res = await ax.post(uploadUrl, form, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, ...form.getHeaders() },
    timeout: 20000, maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  const mediaId = res?.data?.id;
  if (!mediaId) throw new Error('[WABA] Upload retornou sem id');
  return mediaId;
}

// ============== Normalização de conteúdo por tipo ==============
function coerceContent(type, content) {
  const c = typeof content === 'string' ? { body: content } : { ...(content || {}) };
  if (type === 'text') {
    if (!c.body && c.text) c.body = c.text; // sempre { body: "..." }
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
        const mediaId = await uploadMediaFromUrl(mediaUrl);
        payload[type] = { id: mediaId };
        if (type === 'audio' && content.voice === true) payload[type].voice = true;
        if (content.caption) payload[type].caption = content.caption;
        if (content.filename && type === 'document') payload[type].filename = content.filename;
        return payload;
      } catch (e) {
        console.warn('[WABA] Upload falhou, caindo para link:', e?.message);
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

// -------- update rico para não “apagar” a mensagem no front ------
function buildSafeUpdate({ to, tempId, providerId, type, content, status, reason }) {
  const id = tempId || providerId || null;
  const update = {
    id,
    user_id: to,           // como você pediu (sem @w.msgcli.net)
    channel: 'whatsapp',
    message_id: id,
    provider_id: providerId || undefined,
    status,
    direction: 'outgoing',
    type,
    timestamp: new Date().toISOString(),
  };
  if (reason) update.reason = reason;
  // sempre manda content normalizado no formato do front
  update.content = coerceContent(type, content);
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
    throw new Error(`[WABA] Destinatário inválido: "${toRaw}". Use DDI/DDD com dígitos, ex: 5521999998888`);
  }

  const payload = await buildPayload({ to, type, content, context });

  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  try {
    const res = await ax.post(url, payload, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    const providerId = res?.data?.messages?.[0]?.id || null;

    // DB: sent
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
      console.warn('[whatsappSender] aviso DB (sent):', dbErr?.message);
    }

    // Update rico
    try {
      await emitUpdateMessage(
        buildSafeUpdate({
          to,
          tempId: job.tempId,
          providerId,
          type,
          content,        // mantém o mesmo conteúdo que a UI conhece
          status: 'sent',
        })
      );
    } catch {}

    return { ok: true, providerId, response: res.data };
  } catch (err) {
    const data = err.response?.data;

    // DB: error
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
      console.warn('[whatsappSender] aviso DB (error):', dbErr?.message);
    }

    // Update rico de erro
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

    throw err;
  }
}
