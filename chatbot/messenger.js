// engine/messenger.js
import { sendWebchatMessage } from '../services/sendWebchatMessage.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';

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


