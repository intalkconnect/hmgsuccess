// services/high/processEvent.js
import crypto from 'crypto';
import { dbPool } from '../db.js'; // já inicializado pelo worker via initDB()
import { runFlow } from '../../engine/flowExecutor.js';
import { processMediaIfNeeded } from './processFileHeavy.js';
// Se não existir, comente a import e as chamadas:
import { markMessageAsRead } from '../wa/markMessageAsRead.js';

// Garante existir message_id para a UNIQUE (channel, message_id, user_id)
function ensureMessageId(channel, rawIdParts) {
  const joined = rawIdParts.filter(Boolean).map(String).join(':');
  if (joined) return joined;
  return `gen:${channel}:${crypto.randomUUID()}`;
}

async function insertClienteIfAbsent({ phone, name, channel, userId }) {
  await dbPool.query(`
    INSERT INTO clientes (phone, name, channel, user_id, create_at)
    SELECT $1, $2, $3, $4, NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM clientes WHERE user_id = $4 OR phone = $1
    )
  `, [phone, name, channel, userId]);
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

async function getActiveFlow() {
  const { rows } = await dbPool.query(`SELECT * FROM flows WHERE active = true LIMIT 1`);
  return rows[0]?.data || null;
}

// ------------------- WhatsApp -------------------
async function processWhatsApp(evt, { io } = {}) {
  const value = evt?.payload?.entry?.[0]?.changes?.[0]?.value;
  if (!value) return 'duplicate';
  const msg = value?.messages?.[0];
  if (!msg) return 'duplicate';

  const from = value?.contacts?.[0]?.wa_id;
  const profileName = value?.contacts?.[0]?.profile?.name || 'usuário';
  const formattedUserId = `${from}@w.msgcli.net`;
  const msgType = msg.type;

  const { content, userMessage } = await processMediaIfNeeded('whatsapp', { msg });

  await insertClienteIfAbsent({
    phone: from,
    name: profileName,
    channel: 'whatsapp',
    userId: formattedUserId
  });

  const messageId = ensureMessageId('whatsapp', [msg.id]);
  const inserted = await upsertIncomingMessage({
    channel: 'whatsapp',
    userId: formattedUserId,
    messageId,
    msgType,
    content
  });
  if (!inserted) return 'duplicate';

  try { if (msg.id) await markMessageAsRead(msg.id); } catch {}

  // Socket (mesma semântica do seu projeto): new_message + bot_processing
  if (io) {
    io.emit('new_message', inserted);
    const statusPayload = { user_id: formattedUserId, status: 'processing' };
    io.emit('bot_processing', statusPayload);
    // se você usava rooms por user:
    io.emit(`chat-${formattedUserId}`, inserted);
    io.emit(`chat-${formattedUserId}`, { type: 'bot_processing', ...statusPayload });
  }

  const activeFlow = await getActiveFlow();

  const outgoingMessage = await runFlow({
    message: (userMessage || '').toLowerCase(),
    flow: activeFlow,
    vars: {
      userPhone: from,
      userName: profileName,
      lastUserMessage: userMessage,
      channel: 'whatsapp',
      now: new Date().toISOString(),
      lastMessageId: msg.id
    },
    rawUserId: from,
    io
  });

  if (io && outgoingMessage?.user_id) {
    io.emit('new_message', outgoingMessage);
    io.emit(`chat-${formattedUserId}`, outgoingMessage);
  }

  return 'ok';
}

// ------------------- Telegram -------------------
async function processTelegram(evt, { io } = {}) {
  const update = evt?.payload;
  if (!update) return 'duplicate';

  const message = update.message || update.callback_query?.message;
  const from = update.message?.from || update.callback_query?.from;
  const chatId = message?.chat?.id;
  const userId = `${chatId}@t.msgcli.net`;

  const { content, userMessage, msgType } = await processMediaIfNeeded('telegram', { update, message });

  await insertClienteIfAbsent({
    phone: String(chatId),
    name: `${from?.first_name || ''} ${from?.last_name || ''}`.trim(),
    channel: 'telegram',
    userId
  });

  const messageId = ensureMessageId('telegram', [chatId, (message?.message_id ?? update.update_id)]);
  const inserted = await upsertIncomingMessage({
    channel: 'telegram',
    userId,
    messageId,
    msgType,
    content
  });
  if (!inserted) return 'duplicate';

  if (io) {
    io.emit('new_message', inserted);
    const statusPayload = { user_id: userId, status: 'processing' };
    io.emit('bot_processing', statusPayload);
    io.emit(`chat-${userId}`, inserted);
    io.emit(`chat-${userId}`, { type: 'bot_processing', ...statusPayload });
  }

  const activeFlow = await getActiveFlow();

  const outgoingMessage = await runFlow({
    message: (userMessage || '').toLowerCase(),
    flow: activeFlow,
    vars: {
      userPhone: String(chatId),
      userName: `${from?.first_name || ''} ${from?.last_name || ''}`.trim(),
      lastUserMessage: userMessage,
      channel: 'telegram',
      now: new Date().toISOString()
    },
    rawUserId: String(chatId),
    io
  });

  if (io && outgoingMessage?.user_id) {
    io.emit('new_message', outgoingMessage);
    io.emit(`chat-${userId}`, outgoingMessage);
  }

  return 'ok';
}

// ------------------- Router -------------------
export async function processEvent(evt, { io } = {}) {
  const ch = evt?.channel;
  if (!ch) return 'duplicate';
  if (ch === 'whatsapp') return processWhatsApp(evt, { io });
  if (ch === 'telegram') return processTelegram(evt, { io });
  return 'ok';
}
