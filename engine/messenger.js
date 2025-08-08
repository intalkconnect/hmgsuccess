// engine/messenger.js

import { sendWebchatMessage } from '../services/sendWebchatMessage.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
import { sendTelegramMessage } from '../services/sendTelegramMessage.js';
import { MessageAdapter } from './messageAdapters.js';
import { CHANNELS } from './messageTypes.js';

/**
 * Encapsula envio em diferentes canais usando payload unificado.
 */
export async function sendMessageByChannel(channel, to, type, content, context) {
  // Cria payload unificado
  const unifiedMessage = {
    type,
    content,
    metadata: { context }
  };

  try {
    switch (channel) {
      case CHANNELS.WEBCHAT:
        return sendWebchatMessage({ to, content: unifiedMessage });
      
      case CHANNELS.WHATSAPP:
        const whatsappContent = MessageAdapter.toWhatsapp(unifiedMessage);
        return sendWhatsappMessage({ 
          to, 
          type, 
          content: whatsappContent, 
          context 
        });
      
      case CHANNELS.TELEGRAM:
        const telegramContent = MessageAdapter.toTelegram(unifiedMessage);
        return sendTelegramMessage({
          chatId: to,
          type,
          content: telegramContent
        });
      
      default:
        throw new Error(`Canal não suportado: ${channel}`);
    }
  } catch (error) {
    console.error(`Erro ao enviar mensagem via ${channel}:`, error);
    throw error;
  }
}
