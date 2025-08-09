// services/high/processEvent.js
'use strict';

// Ajuste os caminhos conforme seu projeto:
const { dbPool } = require('../db'); // deve exportar um pg.Pool
const { runFlow } = require('../../engine/flowExecutor');
const { markMessageAsRead } = require('../wa/markMessageAsRead'); // opcional p/ WhatsApp
const { processMediaIfNeeded } = require('./processFileHeavy');
const crypto = require('crypto');

// Helpers -------------------------------------------------

function ensureMessageId(channel, rawIdParts) {
  // Garante que teremos "message_id" não-nulo para satisfazer a UNIQUE (channel, message_id, user_id)
  const joined = rawIdParts.filter(Boolean).map(String).join(':');
  if (joined) return joined;
  // fallback: hash do payload quando nada veio
  return `gen:${channel}:${crypto.randomUUID()}`;
}

async function insertClienteIfAbsent({ phone, name, channel, userId }) {
  // Sem UNIQUE em clientes, usamos INSERT … SELECT … WHERE NOT EXISTS
  await dbPool.query(`
    INSERT INTO clientes (phone, name, channel, user_id, create_at)
    SELECT $1, $2, $3, $4, NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM clientes WHERE user_id = $4 OR phone = $1
    )
  `, [phone, name, channel, userId]);
}

async function upsertIncomingMessage({ channel, userId, messageId, msgType, content }) {
  // Idempotência: sua constraint messages_unique_id_per_channel (channel, message_id, user_id)
  const res = await dbPool.query(`
    INSERT INTO messages (
      user_id, message_id, direction, type, content,
      "timestamp", flow_id, reply_to, status, metadata,
      created_at, updated_at, channel
    )
    VALUES ($1, $2, 'incoming', $3, $4,
            NOW(), NULL, NULL, 'received', NULL,
            NOW(), NOW(), $5)
    ON CONFLICT (channel, message_id, user_id) DO NOTHING
    RETURNING id
  `, [
    userId,
    messageId,
    msgType,
    typeof content === 'string' ? content : JSON.stringify(content),
    channel
  ]);

  return res.rowCount > 0; // true se inseriu (não-duplicado)
}

async function getActiveFlow() {
  // sua tabela flows tem unique_active_flow (active = true)
  const { rows } = await dbPool.query(`SELECT * FROM flows WHERE active = true LIMIT 1`);
  return rows[0]?.data || null;
}

// WhatsApp ------------------------------------------------

async function processWhatsApp(evt) {
  const value = evt?.payload?.entry?.[0]?.changes?.[0]?.value;
  if (!value) return 'duplicate';
  const msg = value?.messages?.[0];
  if (!msg) return 'duplicate';

  const from = value?.contacts?.[0]?.wa_id;
  const profileName = value?.contacts?.[0]?.profile?.name || 'usuário';
  const formattedUserId = `${from}@w.msgcli.net`;
  const msgType = msg.type;

  // Pesado → baixa/upload mídia se necessário
  const { content, userMessage } = await processMediaIfNeeded('whatsapp', { value, msg });

  // Cliente
  await insertClienteIfAbsent({
    phone: from,
    name: profileName,
    channel: 'whatsapp',
    userId: formattedUserId
  });

  const messageId = ensureMessageId('whatsapp', [msg.id]);

  // Idempotência + gravação
  const inserted = await upsertIncomingMessage({
    channel: 'whatsapp',
    userId: formattedUserId,
    messageId,
    msgType,
    content
  });
  if (!inserted) return 'duplicate';

  // Marca lida (best-effort)
  try { if (msg.id) markMessageAsRead(msg.id); } catch {}

  const activeFlow = await getActiveFlow();

  await runFlow({
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
    rawUserId: from
  });

  return 'ok';
}

// Telegram -----------------------------------------------

async function processTelegram(evt) {
  const update = evt?.payload;
  if (!update) return 'duplicate';

  const isCallback = !!update.callback_query;
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

  // Use message.message_id ou update.update_id; combine com chatId para unicidade estável
  const messageId = ensureMessageId('telegram', [chatId, (message?.message_id ?? update.update_id)]);

  const inserted = await upsertIncomingMessage({
    channel: 'telegram',
    userId,
    messageId,
    msgType,
    content
  });
  if (!inserted) return 'duplicate';

  const activeFlow = await getActiveFlow();

  await runFlow({
    message: (userMessage || '').toLowerCase(),
    flow: activeFlow,
    vars: {
      userPhone: String(chatId),
      userName: `${from?.first_name || ''} ${from?.last_name || ''}`.trim(),
      lastUserMessage: userMessage,
      channel: 'telegram',
      now: new Date().toISOString()
    },
    rawUserId: String(chatId)
  });

  return 'ok';
}

// Router -------------------------------------------------

async function processEvent(evt) {
  const ch = evt?.channel;
  if (!ch) return 'duplicate';
  if (ch === 'whatsapp') return processWhatsApp(evt);
  if (ch === 'telegram') return processTelegram(evt);
  // IG/FB podem ser adicionados aqui no mesmo padrão
  return 'ok';
}

module.exports = { processEvent };
