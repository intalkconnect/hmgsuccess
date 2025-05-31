// engine/messenger.js
import { sendWebchatMessage } from '../services/sendWebchatMessage.js';
import { sendWhatsappMessage, markAsReadAndTyping } from '../services/sendWhatsappMessage.js';

/**
 * Encapsula envio em diferentes canais.
 */
export async function sendMessageByChannel(channel, to, type, content) {
  if (channel === 'webchat') {
    return sendWebchatMessage({ to, content });
  }
  let whatsappContent;
  if (type === 'text' && typeof content === 'string') {
    whatsappContent = { body: content };
  } else {
    whatsappContent = content;
  }
  return sendWhatsappMessage({ to, type, content: whatsappContent });
}

/**
 * Marca a mensagem como lida e exibe indicador de digitação, se houver ID.
 */
export async function markAsReadIfNeeded(message) {
  if (message?.id) {
    await markAsReadAndTyping(message.id);
  }
}
