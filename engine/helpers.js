// engine/helpers.js
import { substituteVariables } from '../utils/vars.js';
import { evaluateConditions } from './utils.js';
import { sendMessageByChannel } from './messenger.js';

/* --------------------------- Normalização --------------------------- */

export function normalizeStr(v) {
  if (v == null) return '';
  let s = String(v);
  try { s = s.normalize('NFD').replace(/\p{Diacritic}/gu, ''); } catch {}
  return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
}

/* --------------------------- Protocolo --------------------------- */

// Gera um protocolo que termina com os dígitos do ticket
export function buildProtocol(vars = {}) {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const dd   = String(now.getDate()).padStart(2, '0');
  const hh   = String(now.getHours()).padStart(2, '0');
  const mi   = String(now.getMinutes()).padStart(2, '0');

  const rawTicket =
    vars.ticketNumber ??
    vars.ticketId ??
    vars.ticket ??
    vars?.handover?.ticketNumber ??
    vars?.handover?.ticketId ??
    '';

  const ticketDigits = String(rawTicket).replace(/\D+/g, '');
  const suffix = ticketDigits || '0000'; // fallback

  return `PRT-${yyyy}${mm}${dd}-${hh}${mi}-${suffix}`;
}

/* --------------------------- Parsing de mensagens --------------------------- */

export function parseWhatsAppMessage(message) {
  const out = { text: null, id: null, title: null, type: null };
  if (!message) return out;

  out.type = message.type || 'text';

  switch (message.type) {
    case 'text':
      out.text = message.text?.body?.trim() || '';
      break;

    case 'interactive':
      if (message.interactive?.button_reply) {
        out.id = message.interactive.button_reply.id;
        out.title = message.interactive.button_reply.title;
        out.text = message.interactive.button_reply.title; // compat
      } else if (message.interactive?.list_reply) {
        out.id = message.interactive.list_reply.id;
        out.title = message.interactive.list_reply.title;
        out.text = message.interactive.list_reply.title; // compat
      }
      break;

    case 'button':
      out.id = message.button?.payload;
      out.title = message.button?.text;
      out.text = message.button?.text; // compat
      break;

    default:
      if (message.text?.body) out.text = message.text.body.trim();
      else if (message.body)  out.text = message.body.trim();
  }

  return out;
}

export function parseInboundMessage(msg) {
  const out = { text: null, id: null, title: null, type: null };

  try {
    // Meta WhatsApp Business API (webhook oficial)
    if (msg?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const message = msg.entry[0].changes[0].value.messages[0];
      return parseWhatsAppMessage(message);
    }

    // Outras libs que já extraem "messages"
    if (msg?.messages?.[0]) return parseWhatsAppMessage(msg.messages[0]);

    // Mensagem direta (tests)
    if (typeof msg === 'string') {
      out.text = msg.trim();
      out.type = 'text';
      return out;
    }

    // Estrutura alternativa
    if (msg?.message) return parseWhatsAppMessage(msg.message);

    return parseWhatsAppMessage(msg);

  } catch (error) {
    console.error('Error parsing message:', error);
    return out;
  }
}

/* --------------------------- Flow helpers --------------------------- */

export function resolveOnErrorId(flow) {
  if (flow?.blocks?.onerror) return 'onerror';
  const entry = Object.entries(flow?.blocks || {}).find(
    ([, b]) => (b?.label || '').toLowerCase() === 'onerror'
  );
  return entry ? entry[0] : null;
}

// Mapa id<->title do bloco interativo atual (list ou button)
export function buildInteractiveAliases(block) {
  const out = { id2title: {}, title2id: {} };
  const c = block?.content;
  if (!c) return out;

  if (c.type === 'list') {
    for (const section of c.action?.sections || []) {
      for (const row of section.rows || []) {
        if (!row?.id || !row?.title) continue;
        out.id2title[row.id] = row.title;
        out.title2id[normalizeStr(row.title)] = row.id;
      }
    }
  }

  if (c.type === 'button') {
    for (const b of c.action?.buttons || []) {
      const id = b?.reply?.id;
      const title = b?.reply?.title;
      if (!id || !title) continue;
      out.id2title[id] = title;
      out.title2id[normalizeStr(title)] = id;
    }
  }

  return out;
}

// Avaliação de condições com fallback (id/title/normalização)
export function evalConditionsSmart(conditions = [], vars = {}) {
  if (evaluateConditions(conditions, vars)) return true;

  if (vars.lastReplyId) {
    const v2 = { ...vars, lastUserMessage: vars.lastReplyId };
    if (evaluateConditions(conditions, v2)) return true;
  }
  if (vars.lastReplyTitle) {
    const v3 = { ...vars, lastUserMessage: vars.lastReplyTitle };
    if (evaluateConditions(conditions, v3)) return true;
  }

  const vNorm = {
    ...vars,
    lastUserMessage: normalizeStr(vars.lastUserMessage),
    lastReplyId: normalizeStr(vars.lastReplyId),
    lastReplyTitle: normalizeStr(vars.lastReplyTitle),
  };
  const cNorm = (conditions || []).map((c) => {
    if (!c) return c;
    const type = c.type?.toLowerCase?.();
    if (['equals','not_equals','contains','starts_with','ends_with'].includes(type)) {
      return { ...c, value: normalizeStr(c.value) };
    }
    return c;
  });
  if (evaluateConditions(cNorm, vNorm)) return true;

  const poolRaw = Array.isArray(vars._candidates) ? vars._candidates : [];
  const pool = Array.from(new Set(
    [
      vars.lastUserMessage,
      vars.lastReplyTitle,
      vars.lastReplyId,
      ...poolRaw
    ].filter(Boolean).map(normalizeStr)
  ));

  for (const candidate of pool) {
    const v = {
      ...vars,
      lastUserMessage: candidate,
      lastReplyId: normalizeStr(vars.lastReplyId),
      lastReplyTitle: normalizeStr(vars.lastReplyTitle),
    };
    if (evaluateConditions(cNorm, v)) return true;
  }

  return false;
}

export function determineNextSmart(block, vars, flow, currentId) {
  for (const action of block?.actions || []) {
    if (evalConditionsSmart(action.conditions || [], vars)) {
      return action.next;
    }
  }
  if (block?.defaultNext && flow.blocks[block.defaultNext]) {
    return block.defaultNext;
  }
  return null;
}

/* --------------------------- Envio com substituição --------------------------- */

// Envia mensagem configurada (off-hours / pre-human etc.) com substituição de variáveis
export async function sendConfiguredMessage(entry, { channel, userId, io, vars }) {
  if (!entry) return null;

  if (entry.delayMs) {
    const ms = Number(entry.delayMs);
    if (!Number.isNaN(ms) && ms > 0) await new Promise(r => setTimeout(r, ms));
  }

  const type = entry.type || 'text';
  const raw =
    typeof entry.message === 'string'
      ? entry.message
      : JSON.stringify(entry.payload || entry.content || null);

  if (!raw) return null;

  // aplica {{...}} sobre string ou JSON
  const substituted = substituteVariables(raw, vars || {});
  const content = (typeof entry.message === 'string')
    ? { text: substituted }
    : JSON.parse(substituted);

  try {
    const rec = await sendMessageByChannel(channel, userId, type, content);
    if (io && rec) {
      try { io.emit('new_message', rec); } catch {}
      try { io.to(`chat-${userId}`).emit('new_message', rec); } catch {}
    }
    return rec;
  } catch (e) {
    console.error('[helpers] sendConfiguredMessage error:', e);
    return null;
  }
}

/* --------------------------- Outros --------------------------- */

export function resolveByIdOrLabel(flow, key) {
  if (!key) return null;
  if (flow.blocks[key]) return key;
  const found = Object.entries(flow.blocks).find(([, b]) => (b?.label || '') === key);
  return found ? found[0] : null;
}
