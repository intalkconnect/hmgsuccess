// services/high/processEvent.js
import crypto from 'crypto';
import { dbPool } from '../../engine/services/db.js';
import { runFlow } from '../../engine/flowExecutor.js';
import { processMediaIfNeeded } from './processFileHeavy.js';
import { emitToRoom } from '../realtime/emitToRoom.js';
import { distribuirTicket } from '../../engine/ticketManager.js';

// ---------- helpers de ID ----------
function ensureMessageId(channel, rawIdParts) {
  const joined = rawIdParts.filter(Boolean).map(String).join(':');
  return joined || `gen:${channel}:${crypto.randomUUID()}`;
}
function stripSuffix(userId = '') {
  // transforma "888@w.msgcli.net" -> "888"
  const i = String(userId).indexOf('@');
  return i > 0 ? String(userId).slice(0, i) : String(userId);
}

// ---------- DB helpers ----------
async function insertClienteIfAbsent({ phone, name, channel, userId, fila }) {
  await dbPool.query(`
    INSERT INTO clientes (phone, name, channel, user_id, fila, create_at)
    SELECT $1, $2, $3, $4, $5, NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM clientes WHERE user_id = $4
    )
  `, [phone, name, channel, userId, fila || null]);
}

async function upsertIncomingMessage({ channel, userId, messageId, msgType, content }) {
  const res = await dbPool.query(`
    INSERT INTO messages (
      user_id, message_id, direction, "type", "content",
      "timestamp", flow_id, reply_to, status, metadata,
      created_at, updated_at, channel
    )
    VALUES ($1, $2, 'incoming', $3, $4,
            NOW(), NULL, NULL, 'received', NULL,
            NOW(), NOW(), $5)
    ON CONFLICT (channel, message_id, user_id) DO NOTHING
    RETURNING *
  `, [
    userId,
    messageId,
    msgType,
    typeof content === 'string' ? content : JSON.stringify(content),
    channel
  ]);
  return res.rows?.[0]; // undefined => duplicate
}

async function getOpenTicket(userId) {
  const { rows } = await dbPool.query(
    `SELECT id, status, fila, assigned_to
       FROM tickets
      WHERE user_id = $1 AND status = 'open'
      LIMIT 1`,
    [userId]
  );
  return rows?.[0] || null;
}

async function getActiveFlow() {
  const { rows } = await dbPool.query(`SELECT * FROM flows WHERE active = true LIMIT 1`);
  return rows[0]?.data || null;
}

// ---------- core: decide fluxo x atendimento ----------
async function handleAfterPersist({ channel, userId, inserted, io, userMessage, vars, rawUserIdForTicket }) {
  // Se já existe ticket aberto (mesmo que sem atendente), não roda o bot.
  const open = await getOpenTicket(userId);
  if (open) {
    // apenas entrega ao front/atendente
    emitToRoom(io, { room: userId, event: 'new_message', data: inserted });
    // opcional: status 'aguardando' se sem assigned_to
    if (!open.assigned_to) {
      emitToRoom(io, { room: userId, event: 'bot_processing', data: { user_id: userId, status: 'waiting' } });
    }
    return 'routed_to_agent';
  }

  // Sem ticket aberto => roda FLOW
  const flow = await getActiveFlow();
  const flowRes = await runFlow({
    message: (userMessage || '').toLowerCase(),
    flow,
    vars,
    rawUserId: rawUserIdForTicket
  });

  if (!flowRes) {
    // sem ação do flow: apenas entrega a entrada ao front
    emitToRoom(io, { room: userId, event: 'new_message', data: inserted });
    return 'ok';
  }

  // 1) handoff para atendimento
  if (flowRes.type === 'handoff') {
    const filaAlvo = flowRes.queue || vars.defaultQueue || 'Default';
    try {
      await distribuirTicket(rawUserIdForTicket, filaAlvo, channel); // cria ticket (sem atendente no modo manual)
      // entrega a entrada ao front
      emitToRoom(io, { room: userId, event: 'new_message', data: inserted });
      // indica visualmente que está aguardando/roteado
      emitToRoom(io, { room: userId, event: 'bot_processing', data: { user_id: userId, status: 'waiting' } });
      return 'handoff';
    } catch (e) {
      console.error('[processEvent] handoff falhou:', e?.message || e);
      // sem travar o fluxo do usuário
      emitToRoom(io, { room: userId, event: 'new_message', data: inserted });
      emitToRoom(io, { room: userId, event: 'bot_processing', data: { user_id: userId, status: 'error' } });
      return 'handoff_error';
    }
  }

  // 2) resposta do flow
  if (flowRes.type === 'reply' && flowRes.reply) {
    // Mostra imediatamente no front (eco do bot)
    const outgoing = {
      id: flowRes.reply.tempId || `tmp:${crypto.randomUUID()}`,
      user_id: userId,
      direction: 'outgoing',
      status: 'pending',
      content: flowRes.reply.content || {},
      channel,
      timestamp: new Date().toISOString()
    };
    emitToRoom(io, { room: userId, event: 'new_message', data: outgoing });

    // Se você tiver um publisher para “hmg.outgoing”, este é o ponto de enfileirar.
    // Exemplo:
    // await publishOutgoing({
    //   channel,
    //   to: flowRes.reply.to,
    //   type: flowRes.reply.msgType,
    //   content: flowRes.reply.content,
    //   context: flowRes.reply.context,
    //   userId
    // });

    return 'replied';
  }

  // fallback: só entrega ao front a mensagem recebida
  emitToRoom(io, { room: userId, event: 'new_message', data: inserted });
  return 'ok';
}

// -------- WhatsApp --------
async function processWhatsApp(evt, { io } = {}) {
  const value = evt?.payload?.entry?.[0]?.changes?.[0]?.value;
  if (!value) return 'duplicate';
  const msg = value?.messages?.[0];
  if (!msg) return 'duplicate';

  const from        = value?.contacts?.[0]?.wa_id;
  const profileName = value?.contacts?.[0]?.profile?.name || 'usuário';
  const userId      = `${from}@w.msgcli.net`;  // room no front
  const msgType     = msg.type;

  const { content, userMessage } = await processMediaIfNeeded('whatsapp', { msg });

  await insertClienteIfAbsent({
    phone: from, name: profileName, channel: 'whatsapp', userId
  });

  const messageId = ensureMessageId('whatsapp', [msg.id]);
  const inserted  = await upsertIncomingMessage({
    channel: 'whatsapp',
    userId,
    messageId,
    msgType,
    content
  });
  if (!inserted) return 'duplicate';

  const vars = {
    userPhone: from,
    userName: profileName,
    lastUserMessage: userMessage,
    channel: 'whatsapp',
    now: new Date().toISOString(),
    lastMessageId: msg.id,
    defaultQueue: 'WhatsApp'
  };

  return handleAfterPersist({
    channel: 'whatsapp',
    userId,
    inserted,
    io,
    userMessage,
    vars,
    rawUserIdForTicket: stripSuffix(userId),
  });
}

// -------- Telegram --------
async function processTelegram(evt, { io } = {}) {
  const update = evt?.payload;
  if (!update) return 'duplicate';

  const message = update.message || update.callback_query?.message;
  const from    = update.message?.from || update.callback_query?.from;
  const chatId  = message?.chat?.id;
  const userId  = `${chatId}@t.msgcli.net`;

  const { content, userMessage, msgType } = await processMediaIfNeeded('telegram', { update, message });

  await insertClienteIfAbsent({
    phone: String(chatId),
    name: `${from?.first_name || ''} ${from?.last_name || ''}`.trim(),
    channel: 'telegram',
    userId
  });

  const messageId = ensureMessageId('telegram', [chatId, (message?.message_id ?? update.update_id)]);
  const inserted  = await upsertIncomingMessage({
    channel: 'telegram',
    userId,
    messageId,
    msgType,
    content
  });
  if (!inserted) return 'duplicate';

  const vars = {
    userPhone: String(chatId),
    userName: `${from?.first_name || ''} ${from?.last_name || ''}`.trim(),
    lastUserMessage: userMessage,
    channel: 'telegram',
    now: new Date().toISOString(),
    defaultQueue: 'Telegram'
  };

  return handleAfterPersist({
    channel: 'telegram',
    userId,
    inserted,
    io,
    userMessage,
    vars,
    rawUserIdForTicket: stripSuffix(userId),
  });
}

// -------- Router --------
export async function processEvent(evt, { io } = {}) {
  const ch = (evt?.channel || '').toLowerCase();
  if (!ch) return 'duplicate';
  if (ch === 'whatsapp') return processWhatsApp(evt, { io });
  if (ch === 'telegram') return processTelegram(evt, { io });
  return 'ok';
}
