// engine/messenger.js (versão resumida)
import { v4 as uuidv4 } from 'uuid';
import { dbPool } from './services/db.js';
import { MessageAdapter } from './messageAdapters.js';
import { CHANNELS } from './messageTypes.js';
import { enqueueOutgoing } from './queue.js';

function normalizeRecipientForChannel(channel, to) {
  if (channel === CHANNELS.WHATSAPP) return String(to).replace(/\D/g, '');
  return to;
}

export async function sendMessageByChannel(channel, to, type, content, context) {
  const toNormalized = normalizeRecipientForChannel(channel, to);
  const userId =
    channel === CHANNELS.WHATSAPP ? `${toNormalized}@w.msgcli.net`
  : channel === CHANNELS.TELEGRAM ? `${toNormalized}@t.msgcli.net`
  : toNormalized;

  // adapta conteúdo para o canal de destino
  const adapted =
    channel === CHANNELS.WHATSAPP ? MessageAdapter.toWhatsapp({ type, content }) :
    channel === CHANNELS.TELEGRAM ? MessageAdapter.toTelegram({ type, content }) :
    content;

  const tempId = uuidv4();
  const dbContent = type === 'text' ? adapted.body : JSON.stringify(adapted);

  // grava como PENDING
  const { rows } = await dbPool.query(`
    INSERT INTO messages (
      user_id, message_id, direction, type, content, timestamp,
      status, metadata, created_at, updated_at, channel
    ) VALUES ($1,$2,'outgoing',$3,$4,NOW(),
             'pending',NULL,NOW(),NOW(),$5)
    RETURNING *
  `, [userId, tempId, type, dbContent, channel]);
  const pending = rows[0];

  // publica para o worker-outgoing
  await enqueueOutgoing({
    tempId,
    channel,
    to: toNormalized,
    userId,
    type,
    content: adapted,
    context,
  });

  return pending; // o chamador pode emitir para o front
}
