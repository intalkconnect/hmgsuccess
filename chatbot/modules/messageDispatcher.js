import { sendWhatsappMessage } from '../../services/sendWhatsappMessage.js';
import { sendWebchatMessage } from '../../services/sendWebchatMessage.js';

export async function dispatchMessage(channel, to, type, content, messageId) {
  if (channel === 'webchat') {
    return sendWebchatMessage({ to, content });
  }

  // Ajuste para payload de texto
  let messageContent = content;
  if (type === 'text' && typeof content === 'string') {
    messageContent = { body: content };
  }

  return sendWhatsappMessage({ to, type, content: messageContent, messageId });
}
