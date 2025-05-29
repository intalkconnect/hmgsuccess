import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
import { sendWebchatMessage } from '../services/sendWebchatMessage.js';
export async function dispatchMessage(channel, to, type, content, messageId) {
  if (channel === 'webchat') return sendWebchatMessage({ to, content });
  return sendWhatsappMessage({ to, type, content, messageId });
}
