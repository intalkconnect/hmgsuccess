// services/high/processEvent.js
import crypto from 'crypto';
import { dbPool } from '../../engine/services/db.js'; // já inicializado no worker via initDB()
import { runFlow } from '../../engine/flowExecutor.js';
import { processMediaIfNeeded } from './processFileHeavy.js';
import { emitToRoom } from '../realtime/emitToRoom.js'; // <-- usa helper via HTTP /emit
import { SYSTEM_EVENT, SYSTEM_EVT_TICKET_STATUS } from '../../engine/messageTypes.js';
import { handleTicketStatusEvent } from './handleTicketStatusEvent.js';
import { loadSession, saveSession } from '../../engine/sessionManager.js';
import { determineNextBlock } from '../../engine/utils.js';


function ensureMessageId(channel, rawIdParts) {
  const joined = rawIdParts.filter(Boolean).map(String).join(':');
  return joined || `gen:${channel}:${crypto.randomUUID()}`;
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

// 🔎 envia para o front já com content "objeto" (e não string JSON)
function parseForEmit(content) {
  if (content == null) return '';
  if (typeof content === 'string') {
    const s = content.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try { return JSON.parse(s); } catch { return content; }
    }
    return content;
  }
  return content;
}

async function getActiveFlow() {
  const { rows } = await dbPool.query(`SELECT * FROM flows WHERE active = true LIMIT 1`);
  return rows[0]?.data || null;
}

/* ===================== WhatsApp ===================== */
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

  await insertClienteIfAbsent({ phone: from, name: profileName, channel: 'whatsapp', userId });

  const messageId = ensureMessageId('whatsapp', [msg.id]);
  const inserted  = await upsertIncomingMessage({
    channel: 'whatsapp',
    userId,
    messageId,
    msgType,
    content
  });
  if (!inserted) return 'duplicate';

  // ✅ emite já com content parseado (objeto)
  await emitToRoom({
    room: userId,
    event: 'new_message',
    payload: { ...inserted, content: parseForEmit(inserted.content) }
  });

  await emitToRoom({ room: userId, event: 'bot_processing', payload: { user_id: userId, status: 'processing' } });

  const flow = await getActiveFlow();
  const outgoing = await runFlow({
    message: (userMessage || '').toLowerCase(),
    flow,
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

  if (outgoing?.user_id) {
    await emitToRoom({ room: userId, event: 'new_message', payload: outgoing });
  }
  return 'ok';
}

/* ===================== Telegram ===================== */
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

  // ✅ emite já com content parseado (objeto)
  await emitToRoom({
    room: userId,
    event: 'new_message',
    payload: { ...inserted, content: parseForEmit(inserted.content) }
  });

  await emitToRoom({ room: userId, event: 'bot_processing', payload: { user_id: userId, status: 'processing' } });

  const flow = await getActiveFlow();
  const outgoing = await runFlow({
    message: (userMessage || '').toLowerCase(),
    flow,
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

  if (outgoing?.user_id) {
    await emitToRoom({ room: userId, event: 'new_message', payload: outgoing });
  }
  return 'ok';
}

/* ===================== Router ===================== */
/* ===================== Router ===================== */
export async function processEvent(evt, { io } = {}) {

  // ✅ Evento de sistema: ticket fechado → marcar sessão e RETOMAR fluxo pelo ACTIVE FLOW do banco
  if (evt?.kind === SYSTEM_EVENT && evt?.event?.type === SYSTEM_EVT_TICKET_STATUS) {
    const result = await handleTicketStatusEvent(evt.event, { io });

    if (result?.resume) {
      const storageUserId = result.storageUserId || evt.event.userId;
      const rawUserId     = result.rawUserId || String(storageUserId || '').split('@')[0];

      // 1) carrega o fluxo ativo do DB (seu padrão atual)
      const flow = await getActiveFlow();

      // 2) lê a sessão e calcula o próximo bloco a partir do bloco human de origem
      const session = await loadSession(storageUserId);
      const vars    = { ...(session?.vars || {}) };

      const originId    = vars?.handover?.originBlock;       // precisa ser salvo quando entra no bloco human
      const originBlock = originId ? flow?.blocks?.[originId] : null;

      let nextFromHuman = null;
      if (originBlock) {
        nextFromHuman = determineNextBlock(originBlock, vars, flow, originId);
      }

      // Fallbacks se não tiver origin ou se o next não existir
      if (!nextFromHuman || !flow?.blocks?.[nextFromHuman]) {
        if (flow?.blocks?.onhumanreturn) nextFromHuman = 'onhumanreturn';
        else if (flow?.blocks?.onerror)  nextFromHuman = 'onerror';
        else                             nextFromHuman = flow?.start;
      }

      // 3) marca handover como “idle” e persiste a sessão JÁ fora do "human"
      const updatedVars = {
        ...vars,
        handover: { ...(vars.handover || {}), status: 'idle', result: 'closed' },
        previousBlock: originId || 'human',
        // ticket.number já foi gravado no handleTicketStatusEvent
      };

      await saveSession(storageUserId, nextFromHuman, session?.flow_id, updatedVars);

      // 4) agora roda o fluxo a partir do próximo bloco
      const outgoing = await runFlow({
        message: null,         // sem nova msg do usuário
        flow,
        vars: undefined,       // usa as vars salvas na sessão
        rawUserId,
        io
      });

      // (opcional) espelhar no front como nos outros handlers
      if (outgoing?.user_id) {
        await emitToRoom({ room: storageUserId, event: 'new_message', payload: outgoing });
      }
    }
    return 'ok';
  }

  const ch = evt?.channel;
  if (!ch) return 'duplicate';
  if (ch === 'whatsapp') return processWhatsApp(evt, { io });
  if (ch === 'telegram') return processTelegram(evt, { io });
  return 'ok';
}

