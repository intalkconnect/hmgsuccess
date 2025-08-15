// services/outgoing/senders/whatsappSender.js
import FormData from 'form-data';
import { ax } from '../../http/ax.js';
import { emitUpdateMessage } from '../../realtime/emitToRoom.js';
import { spawn } from 'child_process';

// ======================= ENVs =======================
const {
  API_VERSION = 'v22.0',
  PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: ACCESS_TOKEN,
  WABA_UPLOAD_MEDIA = 'true',
  // habilite se tiver ffmpeg no container (apk add --no-cache ffmpeg)
  WABA_TRANSMUX_WEBM = 'false',
} = process.env;

// ==================== Util/Guard rails ===================
function assertEnvs() {
  const missing = [];
  if (!API_VERSION) missing.push('API_VERSION');
  if (!PHONE_NUMBER_ID) missing.push('PHONE_NUMBER_ID');
  if (!ACCESS_TOKEN) missing.push('WHATSAPP_TOKEN');
  if (missing.length) throw new Error(`[WABA] Variáveis ausentes: ${missing.join(', ')}`);
}
const normTo = (raw) =>
  String(raw || '').replace(/@w\.msgcli\.net$/i, '').replace(/\D/g, '').replace(/^0+/, '');
const isE164 = (s) => /^\d{7,15}$/.test(s);
const isWebmUrl = (u = '') => /\.webm(\?|#|$)/i.test(String(u || ''));
const wantUpload = () => String(WABA_UPLOAD_MEDIA).toLowerCase() === 'true';
const wantTransmux = () => String(WABA_TRANSMUX_WEBM).toLowerCase() === 'true';

function coerceContent(type, content) {
  if (typeof content === 'string' && type === 'text') return { body: content };
  const c = { ...(content || {}) };
  if (type === 'text' && !c.body && c.text) c.body = c.text;
  if (['image', 'audio', 'video', 'document'].includes(type) && !c.url && c.link) c.url = c.link;
  return c;
}

// Timeout helper para não travar o worker
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`[WABA] Timeout em ${label} (${ms}ms)`)), ms)
    ),
  ]);
}

// ================= Upload helpers =================
async function uploadStreamToWaba(stream, filename = 'media') {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', stream, filename);

  const uploadUrl = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/media`;
  const res = await withTimeout(
    ax.post(uploadUrl, form, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, ...form.getHeaders() },
      timeout: 30000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }),
    45000,
    'upload /media'
  );
  const mediaId = res?.data?.id;
  if (!mediaId) throw new Error('[WABA] Upload retornou sem id');
  return mediaId;
}

function spawnFfmpegWebmToOgg() {
  const args = ['-i', 'pipe:0', '-vn', '-c:a', 'copy', '-f', 'ogg', 'pipe:1'];
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'inherit'] });
  return ff;
}

async function uploadMediaSmart(url, filename, opts = {}) {
  const resp = await withTimeout(
    ax.get(url, { responseType: 'stream', timeout: 20000 }),
    25000,
    'download mídia'
  );

  // Transmux WEBM -> OGG (sem reencode) se habilitado
  if (opts.transmuxWebm && (isWebmUrl(url) || /webm/i.test(String(resp.headers['content-type'])))) {
    try {
      const ff = spawnFfmpegWebmToOgg();
      resp.data.pipe(ff.stdin);
      const oggName = (filename || 'voice').replace(/\.webm$/i, '') + `-${Date.now()}.ogg`;
      console.log('[WABA] 🎚️ Transmux WEBM→OGG e upload por id...');
      return await uploadStreamToWaba(ff.stdout, oggName);
    } catch (e) {
      console.warn('[WABA] Falha na transmux WEBM→OGG, fallback para document:', e?.message);
      throw e; // quem chama decide o fallback
    }
  }

  // Upload “puro” (sem transformação)
  return uploadStreamToWaba(resp.data, filename || 'media');
}

// =================== Payload builder ====================
async function buildPayload({ to, type, content, context }) {
  // Caso especial: ÁUDIO
  if (type === 'audio') {
    const link = content.url;
    if (!link) throw new Error('[WABA] audio.url/link é obrigatório');

    // Estratégias:
    // 1) WEBM + transmux habilitado → upload id + voice
    // 2) WEBM sem transmux → FALLBACK: enviar como DOCUMENT (não trava job)
    // 3) Demais formatos → upload por id se WABA_UPLOAD_MEDIA=true, senão {link}
    if (isWebmUrl(link)) {
      if (wantTransmux()) {
        try {
          const id = await uploadMediaSmart(link, content.filename, { transmuxWebm: true });
          const audio = { id };
          if (content.voice === true) audio.voice = true;
          if (content.caption) audio.caption = content.caption;
          return {
            messaging_product: 'whatsapp',
            to,
            type: 'audio',
            ...(context?.message_id ? { context: { message_id: context.message_id } } : {}),
            audio,
          };
        } catch {
          // FALLBACK como documento (para não reprocessar eternamente)
          console.log('[WABA] ⚠️ Enviando .webm como document (fallback).');
          return {
            messaging_product: 'whatsapp',
            to,
            type: 'document',
            ...(context?.message_id ? { context: { message_id: context.message_id } } : {}),
            document: {
              link,
              filename: content.filename || `audio-${Date.now()}.webm`,
              caption: content.caption,
            },
          };
        }
      } else {
        console.log('[WABA] ⚠️ WEBM detectado e transmux desabilitado → enviando como document.');
        return {
          messaging_product: 'whatsapp',
          to,
          type: 'document',
          ...(context?.message_id ? { context: { message_id: context.message_id } } : {}),
          document: {
            link,
            filename: content.filename || `audio-${Date.now()}.webm`,
            caption: content.caption,
          },
        };
      }
    }

    // Não é WEBM
    if (wantUpload()) {
      const id = await uploadMediaSmart(link, content.filename);
      const audio = { id };
      if (content.voice === true) audio.voice = true;
      if (content.caption) audio.caption = content.caption;
      return {
        messaging_product: 'whatsapp',
        to,
        type: 'audio',
        ...(context?.message_id ? { context: { message_id: context.message_id } } : {}),
        audio,
      };
    }

    // Por link (somente se o formato for aceito pela Cloud API)
    const audio = { link };
    if (content.voice === true) audio.voice = true;
    if (content.caption) audio.caption = content.caption;
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'audio',
      ...(context?.message_id ? { context: { message_id: context.message_id } } : {}),
      audio,
    };
  }

  // Demais mídias
  const payload = { messaging_product: 'whatsapp', to, type };
  if (context?.message_id) payload.context = { message_id: context.message_id };

  if (['image', 'video', 'document'].includes(type)) {
    if (content.id) {
      payload[type] = { id: content.id };
      if (content.caption) payload[type].caption = content.caption;
      if (type === 'document' && content.filename) payload[type].filename = content.filename;
      return payload;
    }
    const mediaUrl = content.url;
    if (!mediaUrl) throw new Error(`[WABA] ${type}.url/link é obrigatório`);

    if (wantUpload()) {
      const id = await uploadMediaSmart(mediaUrl, content.filename);
      payload[type] = { id };
    } else {
      payload[type] = { link: mediaUrl };
    }
    if (content.caption) payload[type].caption = content.caption;
    if (type === 'document' && content.filename) payload[type].filename = content.filename;
    return payload;
  }

  // Location / Text / Interactive
  if (type === 'location') {
    payload.location = {
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

// ===================== Sender principal ======================
export async function sendViaWhatsApp(job) {
  assertEnvs();

  const toRaw = job.to || job.userId || job.user_id;
  const to = normTo(toRaw);
  const type = String(job.type || 'text').toLowerCase();
  const content = coerceContent(type, job.content || {});
  const context = job.context || undefined;

  if (!isE164(to)) {
    throw new Error(`[WABA] Destinatário inválido: "${toRaw}". Use DDI/DDD apenas dígitos, ex: 5521999998888`);
  }

  console.log('[WABA] ➜ sending', { to, type, webm: isWebmUrl(content.url) || undefined });

  // Monta payload (com timeout para não travar)
  const payload = await withTimeout(
    buildPayload({ to, type, content, context }),
    45000,
    'buildPayload'
  );

  // Envia para o Graph
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  try {
    const res = await withTimeout(
      ax.post(url, payload, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 20000,
      }),
      30000,
      'POST /messages'
    );

    const providerId = res?.data?.messages?.[0]?.id || null;

    // Update de sucesso (mesmo formato que você já usa)
    try {
      await emitUpdateMessage({
        user_id: to,
        channel: 'whatsapp',
        message_id: job.tempId || providerId || null,
        provider_id: providerId,
        status: 'sent',
      });
    } catch {}

    return { ok: true, providerId, response: res.data };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error(`❌ [WABA] Falha ao enviar (status ${status ?? 'N/A'}):`, data?.error || err.message);

    try {
      await emitUpdateMessage({
        user_id: to,
        channel: 'whatsapp',
        message_id: job.tempId || null,
        status: 'failed',
        reason: data?.error?.message || err.message || 'send error',
      });
    } catch {}

    throw err; // deixa o worker decidir retry/backoff
  }
}
