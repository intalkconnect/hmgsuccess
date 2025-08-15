// services/outgoing/senders/whatsappSender.js
import FormData from 'form-data';
import { ax } from '../../http/ax.js';
import { emitUpdateMessage } from '../../realtime/emitToRoom.js';
import { spawn } from 'child_process';
import stream from 'stream';
import { promisify } from 'util';

const pipeline = promisify(stream.pipeline);

// ======================= ENVs =======================
const {
  API_VERSION = 'v22.0',
  PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: ACCESS_TOKEN,
  WABA_UPLOAD_MEDIA = 'false',
} = process.env;

// ... (assertEnvs, normalizeWaTo, isE164, coerceContent permanecem iguais)

// ---------- helpers ----------
const isWebm = (u = '') => /\.webm(\?|#|$)/i.test(String(u));
const isAudioType = (t = '') => String(t).toLowerCase() === 'audio';

// transmuxa WEBM -> OGG (sem reencode) e retorna um stream de saída
function transmuxWebmToOgg() {
  // -vn: sem vídeo; -c:a copy: copia o codec Opus; -f ogg: container OGG
  const ff = spawn('ffmpeg', ['-i', 'pipe:0', '-vn', '-c:a', 'copy', '-f', 'ogg', 'pipe:1'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return ff;
}

// upload genérico (stream) para /media
async function uploadStreamToWaba(streamToSend, filename = 'media') {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', streamToSend, filename);

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

// upload de mídia a partir de URL (com tratamento especial para áudio WEBM)
async function uploadMediaSmart(url, type, content) {
  // download sempre em stream
  const resp = await ax.get(url, { responseType: 'stream', timeout: 20000 });
  const ct = String(resp.headers['content-type'] || '');
  let outStream = resp.data;
  let outName = content?.filename || 'media';

  if (isAudioType(type) && (isWebm(url) || /webm/i.test(ct))) {
    // transmux WEBM -> OGG rapidamente (sem re-encode)
    const ff = transmuxWebmToOgg();
    // pipe download -> ffmpeg.stdin
    resp.data.pipe(ff.stdin);
    outStream = ff.stdout;

    // nome final .ogg
    outName = (outName || 'voice').replace(/\.webm$/i, '');
    outName = `${outName || 'voice'}-${Date.now()}.ogg`;
  }

  return uploadStreamToWaba(outStream, outName);
}

// =================== Payload builder ====================
async function buildPayload({ to, type, content, context }) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type,
  };

  if (context?.message_id) {
    payload.context = { message_id: context.message_id };
  }

  // AUDIO (tratamento especial)
  if (type === 'audio') {
    const mediaUrl = content.url;
    if (!mediaUrl) throw new Error('[WABA] audio.url/link é obrigatório');

    const needsTransmux = isWebm(mediaUrl);
    const wantUpload =
      needsTransmux || String(WABA_UPLOAD_MEDIA).toLowerCase() === 'true';

    if (wantUpload) {
      const mediaId = await uploadMediaSmart(mediaUrl, 'audio', content);
      payload.audio = { id: mediaId };
      if (content.voice === true) payload.audio.voice = true;
      if (content.caption) payload.audio.caption = content.caption;
      return payload;
    }

    // envio por link (só use se for formato aceito pelo WABA)
    payload.audio = { link: mediaUrl };
    if (content.voice === true) payload.audio.voice = true;
    if (content.caption) payload.audio.caption = content.caption;
    return payload;
  }

  // MEDIA genéricos (image, video, document)
  if (['image', 'video', 'document'].includes(type)) {
    if (content.id) {
      payload[type] = { id: content.id };
      if (content.caption) payload[type].caption = content.caption;
      if (type === 'document' && content.filename) payload[type].filename = content.filename;
      return payload;
    }

    const mediaUrl = content.url;
    if (!mediaUrl) throw new Error(`[WABA] ${type}.url/link é obrigatório`);

    const wantUpload = String(WABA_UPLOAD_MEDIA).toLowerCase() === 'true';
    if (wantUpload) {
      // upload “direto” sem transformação
      const resp = await ax.get(mediaUrl, { responseType: 'stream', timeout: 20000 });
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('file', resp.data, content.filename || 'media');

      const uploadUrl = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/media`;
      const upRes = await ax.post(uploadUrl, form, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, ...form.getHeaders() },
        timeout: 20000, maxContentLength: Infinity, maxBodyLength: Infinity,
      });

      const mediaId = upRes?.data?.id;
      if (!mediaId) throw new Error('[WABA] Upload retornou sem id');

      payload[type] = { id: mediaId };
      if (content.caption) payload[type].caption = content.caption;
      if (type === 'document' && content.filename) payload[type].filename = content.filename;
      return payload;
    }

    payload[type] = { link: mediaUrl };
    if (content.caption) payload[type].caption = content.caption;
    if (type === 'document' && content.filename) payload[type].filename = content.filename;
    return payload;
  }

  // LOCATION
  if (type === 'location') {
    payload[type] = {
      latitude: content.latitude,
      longitude: content.longitude,
      ...(content.name ? { name: content.name } : {}),
      ...(content.address ? { address: content.address } : {}),
    };
    return payload;
  }

  // outros (text, interactive, etc.)
  payload[type] = content;
  return payload;
}

// ===================== Sender principal ======================
export async function sendViaWhatsApp(job) {
  // ... assertEnvs e normalização iguais ...
  assertEnvs();
  const toRaw = job.to || job.userId || job.user_id;
  const to = (String(toRaw || '').replace(/@w\.msgcli\.net$/i, '')).replace(/\D/g, '').replace(/^0+/, '');
  const type = String(job.type || 'text').toLowerCase();
  const content = (() => {
    if (typeof job.content === 'string' && type === 'text') return { body: job.content };
    const c = { ...(job.content || {}) };
    if (type === 'text' && !c.body && c.text) c.body = c.text;
    if (['image', 'audio', 'video', 'document'].includes(type) && !c.url && c.link) c.url = c.link;
    return c;
  })();
  const context = job.context || undefined;

  if (!/^\d{7,15}$/.test(to)) {
    throw new Error(`[WABA] Destinatário inválido: "${toRaw}". Use DDI/DDD apenas dígitos, ex: 5521999998888`);
  }

  // Monta payload final (com transmux se necessário)
  const payload = await buildPayload({ to, type, content, context });

  // Envia para o Graph
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

    throw err;
  }
}
