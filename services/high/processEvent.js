// services/high/processEvent.js (ESM)
import pg from 'pg';
import crypto from 'crypto';
import { runFlow } from '../../engine/flowExecutor.js';
import { processMediaIfNeeded } from './processFileHeavy.js';
// marque como opcional se ainda não existir no repo
import { markMessageAsRead } from '../wa/markMessageAsRead.js'; // ajuste/remoção se necessário

const { Pool } = pg;
const dbPool = new Pool({ connectionString: process.env.DATABASE_URL });

// ------------ helpers ------------
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
    RETURNING id
  `, [
    userId,
    messageId,
    msgType,
    typeof content === 'string' ? content : JSON.stringify(content),
    channel
  ]);
  return res.rowCount > 0;
}

async function getActiveFlow() {
  const { rows } = await dbPool.query(`SELECT * FROM flows WHERE active = true LIMIT 1`);
  return rows[0]?.data || null;
}

// ------------ canais ------------
async function processWhatsApp(evt) {
  const value = evt?.payload?.entry?.[0]?.changes?.[0]?.value;
  if (!value) return 'duplicate';
  const msg = value?.messages?.[0];
  if (!msg) return 'duplicate';

  const from = value?.contacts?.[0]?.wa_id;
  const profileName = value?.contacts?.[0]?.profile?.name || 'usuário';
  const formattedUserId = `${from}@w.msgcli.net`;
  const msgType = msg.type;

  const { content, userMessage } = await processMediaIfNeeded('whatsapp', { value, msg });

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

async function processTelegram(evt) {
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

export async function processEvent(evt) {
  const ch = evt?.channel;
  if (!ch) return 'duplicate';
  if (ch === 'whatsapp') return processWhatsApp(evt);
  if (ch === 'telegram') return processTelegram(evt);
  return 'ok';
}
