import { splitUserId } from '../utils/identity.js';
import { sendWhatsappMessage } from './sendWhatsappMessage.js';
import { sendTelegramMessage } from './sendTelegramMessage.js';

export async function sendMessage(payload) {
  // payload: { user_id, type, content, context }
  const { user_id, type, content, context } = payload;
  const { id, channel, suffix } = splitUserId(user_id);

  if (channel === 'telegram') {
    // Telegram espera chat_id "puro"
    return sendTelegramMessage(id, content, context, type);
  }

  if (channel === 'whatsapp') {
    // WhatsApp Cloud API espera { to, type, ... }
    let normalized = content;
    if (type === 'text' && typeof content === 'string') {
      normalized = { body: content };
    }
    return sendWhatsappMessage({ to: id, type, content: normalized, context });
  }

  throw new Error(`Canal não suportado: ${suffix}`);
}
