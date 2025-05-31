// engine/messenger.js
import { sendWhatsappMessage, markAsReadAndTyping } from '../services/sendWhatsappMessage.js';
import { sendWebchatMessage } from '../services/sendWebchatMessage.js';

export async function sendMessageByChannel(channel, to, type, content) {
  if (channel === 'webchat') {
    return sendWebchatMessage({ to, content });
  }
  const formatted = (type === 'text' && typeof content === 'string')
    ? { body: content }
    : content;
  return sendWhatsappMessage({ to, type, content: formatted });
}

export async function markAsReadIfNeeded(message) {
  if (message?.id) {
    await markAsReadAndTyping(message.id);
  }
}
