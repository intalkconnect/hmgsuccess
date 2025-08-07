// adapters/messenger.js
import { sendWhatsappMessage } from './sendWhatsappMessage.js';
import { sendTelegramMessage } from './sendTelegramMessage.js';

export async function sendMessageByChannel(channel, to, type, content, context) {
  if (channel === 'telegram') {
    return sendTelegramMessage(to, content, context, type);
  }

  let whatsappContent = type === 'text' && typeof content === 'string'
    ? { body: content }
    : content;

  return sendWhatsappMessage({ to, type, content: whatsappContent, context });
}

export function getChannelByUserId(userId) {
  if (userId.endsWith('@telegram')) return 'telegram';
  if (userId.endsWith('@webchat')) return 'webchat';
  if (userId.endsWith('@w.msgcli.net')) return 'whatsapp';
  return 'desconhecido'; // fallback padrão
}
