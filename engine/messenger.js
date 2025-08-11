// engine/messenger.js
import { sendWebchatMessage } from '../services/sendWebchatMessage.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
import { sendTelegramMessage } from '../services/sendTelegramMessage.js';
import { MessageAdapter } from './messageAdapters.js';
import { CHANNELS } from './messageTypes.js';

function normalizeRecipientForChannel(channel, to) {
  if (channel === CHANNELS.WHATSAPP) {
    return String(to).replace(/@w\.msgcli\.net$/i, '').replace(/\D/g, '');
  }
  return to;
}

export async function sendMessageByChannel(channel, to, type, content, context) {
  const toNormalized = normalizeRecipientForChannel(channel, to);

  const unifiedMessage = { type, content, metadata: { context } };

  try {
    switch (channel) {
      case CHANNELS.WEBCHAT:
        return sendWebchatMessage({ to: toNormalized, content: unifiedMessage });

      case CHANNELS.WHATSAPP: {
        const whatsappContent = MessageAdapter.toWhatsapp(unifiedMessage);
        return sendWhatsappMessage({
          to: toNormalized,
          type,
          content: whatsappContent,
          context,
        });
      }

      case CHANNELS.TELEGRAM: {
        const telegramContent = MessageAdapter.toTelegram(unifiedMessage);
        return sendTelegramMessage({
          chatId: toNormalized,
          type,
          content: telegramContent,
        });
      }

      default:
        throw new Error(`Canal não suportado: ${channel}`);
    }
  } catch (error) {
    console.error(`Erro ao enviar mensagem via ${channel}:`, error);
    throw error;
  }
}
