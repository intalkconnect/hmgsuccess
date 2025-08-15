// services/outgoing/senders/telegramSender.js
import axios from 'axios';
import { emitUpdateMessage } from '../../realtime/emitToRoom.js';

// ======================= ENVs =======================
const {
  TELEGRAM_BOT_TOKEN,
  TG_PARSE_MODE = '',                 // 'MarkdownV2' | 'HTML' | ''
  TG_DISABLE_LINK_PREVIEWS = 'false', // 'true' para não mostrar preview em links
} = process.env;

// ======================= Guard rails =======================
function assertEnvs() {
  const missing = [];
  if (!TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (missing.length) throw new Error(`[TG] Variáveis ausentes: ${missing.join(', ')}`);
}

const BASE = () => `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ======================= Helpers =======================
async function tgCall(method, payload) {
  const url = `${BASE()}/${method}`;
  const res = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  if (!res.data?.ok) {
    const desc = res.data?.description || 'unknown error';
    const code = res.data?.error_code;
    throw new Error(`[TG] API error ${code || ''}: ${desc}`);
  }
  return res.data.result;
}

// Remove sufixo interno e normaliza chat_id
function normalizeTgChatId(toRaw) {
  if (!toRaw) return toRaw;
  let s = String(toRaw).trim();

  // remove sufixo interno tipo "@t.msgcli.net"
  s = s.replace(/@t\.msgcli\.net$/i, '');

  // permite usernames (@canal) sem mexer
  if (s.startsWith('@')) return s;

  // permite IDs negativos (supergrupos/canais); remove tudo que não for dígito/-
  s = s.replace(/[^\d-]/g, '');

  return s || toRaw;
}

// Mapeia variações vindas do front: body/text, url/link, replyMarkup/reply_markup
function coerceContent(type, content) {
  if (typeof content === 'string' && type === 'text') return { body: content };

  const c = { ...(content || {}) };

  if (type === 'text') {
    if (!c.body && c.text) c.body = c.text;
    if (c.body == null) c.body = '';
  }

  if (['image', 'photo', 'audio', 'video', 'document'].includes(type)) {
    if (!c.url && c.link) c.url = c.link; // front pode mandar "link"
  }

  if (c.replyMarkup && !c.reply_markup) c.reply_markup = c.replyMarkup;
  return c;
}

// Constrói reply_markup (inline keyboard / reply keyboard / remove / force_reply)
function buildReplyMarkup(markup) {
  if (!markup) return undefined;

  // já no formato Telegram?
  if (markup.inline_keyboard || markup.keyboard || markup.remove_keyboard || markup.force_reply) {
    return markup;
  }

  // formato simplificado
  if (markup.inline) return { inline_keyboard: markup.inline };
  if (markup.keyboard) {
    return {
      keyboard: markup.keyboard,
      resize_keyboard: !!markup.resize,
      one_time_keyboard: !!markup.one_time,
    };
  }
  if (markup.remove) return { remove_keyboard: true };
  if (markup.force_reply) return { force_reply: true, selective: !!markup.selective };

  return undefined;
}

function truthy(v) {
  return String(v).toLowerCase() === 'true';
}

// ===================== Sender principal ======================
export async function sendViaTelegram(job) {
  assertEnvs();

  // 1) Normalização básica a partir do payload do front (/messages/send)
  //    { to, channel: 'telegram', type, content: { body | url | caption | filename }, context? }
  const chat_id = normalizeTgChatId(job.to || job.userId || job.user_id);
  const typeRaw = String(job.type || 'text').toLowerCase();
  const type = typeRaw === 'image' ? 'photo' : typeRaw; // "image" -> "photo" no TG
  const content = coerceContent(type, job.content || {});
  const context = job.context || undefined;

  // 2) Opções comuns
  const common = {};
  if (context?.message_id) common.reply_to_message_id = context.message_id;

  const reply_markup = buildReplyMarkup(content.reply_markup || job.reply_markup);
  if (reply_markup) common.reply_markup = reply_markup;

  const parse_mode = content.parse_mode || TG_PARSE_MODE || undefined;

  // 3) Envio
  try {
    let result;

    switch (type) {
      case 'text': {
        const disable_preview = content.disable_web_page_preview ?? truthy(TG_DISABLE_LINK_PREVIEWS);
        result = await tgCall('sendMessage', {
          chat_id,
          text: content.body,
          ...(parse_mode ? { parse_mode } : {}),
          disable_web_page_preview: !!disable_preview,
          ...common,
        });
        break;
      }

      case 'photo': {
        // front manda: { url, caption? }
        result = await tgCall('sendPhoto', {
          chat_id,
          photo: content.file_id || content.url,
          ...(content.caption ? { caption: content.caption } : {}),
          ...(parse_mode ? { parse_mode } : {}),
          ...common,
        });
        break;
      }

      case 'audio': {
        // front manda: { url, caption?, filename? }
        result = await tgCall('sendAudio', {
          chat_id,
          audio: content.file_id || content.url,
          ...(content.caption ? { caption: content.caption } : {}),
          ...(parse_mode ? { parse_mode } : {}),
          ...common,
        });
        break;
      }

      case 'video': {
        result = await tgCall('sendVideo', {
          chat_id,
          video: content.file_id || content.url,
          ...(content.caption ? { caption: content.caption } : {}),
          ...(parse_mode ? { parse_mode } : {}),
          ...common,
        });
        break;
      }

      case 'document': {
        result = await tgCall('sendDocument', {
          chat_id,
          document: content.file_id || content.url,
          ...(content.caption ? { caption: content.caption } : {}),
          ...(parse_mode ? { parse_mode } : {}),
          ...common,
        });
        break;
      }

      // Opcional: se o front um dia mandar "location"
      case 'location': {
        result = await tgCall('sendLocation', {
          chat_id,
          latitude: content.latitude,
          longitude: content.longitude,
          ...common,
        });
        break;
      }

      // Opcional: caso use "interactive" (texto + teclado)
      case 'interactive': {
        const text = content.body || content.text || '';
        const markup = buildReplyMarkup(content.reply_markup || content.action || content.markup);
        result = await tgCall('sendMessage', {
          chat_id,
          text,
          ...(parse_mode ? { parse_mode } : {}),
          ...(markup ? { reply_markup: markup } : {}),
          ...common,
        });
        break;
      }

      default:
        throw new Error(`[TG] Tipo não suportado pelo sender: ${type}`);
    }

    // 4) Notifica sucesso para o front
    const messageId = Array.isArray(result)
      ? result.map(r => r?.message_id).filter(Boolean)
      : result?.message_id;

    try {
      await emitUpdateMessage({
        user_id: chat_id,
        channel: 'telegram',
        message_id: job.tempId || messageId || null,
        status: 'sent',
        provider_id: messageId,
      });
    } catch {}

    return { ok: true, providerId: messageId, response: result };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error(`❌ [TG] Falha ao enviar (${status ?? 'N/A'}):`, data?.description || err.message);

    // 5) Notifica falha para a UI
    try {
      await emitUpdateMessage({
        user_id: chat_id,
        channel: 'telegram',
        message_id: job.tempId || null,
        status: 'failed',
        reason: data?.description || err.message || 'send error',
      });
    } catch {}

    throw err; // deixa o worker fazer retry/backoff
  }
}
