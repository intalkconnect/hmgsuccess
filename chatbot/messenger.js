import { sendWebchatMessage } from '../services/sendWebchatMessage.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
import { sendTelegramMessage } from '../services/sendTelegramMessage.js';

export async function sendMessageByChannel(channel, to, type, content, context) {
  if (channel === 'webchat') {
    return sendWebchatMessage({ to, content });
  }

  if (channel === 'telegram') {
    return sendTelegramMessage(to, typeof content === 'string' ? content : JSON.stringify(content));
  }

  // padrão: WhatsApp
  let whatsappContent = type === 'text' && typeof content === 'string'
    ? { body: content }
    : content;

  return sendWhatsappMessage({ to, type, content: whatsappContent, context });
}

export function getChannelByUserId(userId) {
  if (userId.endsWith('@telegram')) return 'telegram';
  if (userId.endsWith('@webchat')) return 'webchat';
  if (userId.endsWith('@w.msgcli.net')) return 'whatsapp';
  return 'whatsapp'; // fallback
}
