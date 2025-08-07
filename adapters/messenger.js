import { sendWhatsappMessage } from './sendWhatsappMessage.js'
import { sendTelegramMessage } from './sendTelegramMessage.js'

export async function sendMessageByChannel(channel, to, type, content, context) {
  switch (channel) {
    case 'whatsapp':
      return sendWhatsappMessage({ to, type, content, context })
    case 'telegram':
      return sendTelegramMessage({ to, type, content, context })
    default:
      throw new Error('Canal não suportado: ' + channel)
  }
}

export function getChannelByUserId(userId) {
  if (userId.endsWith('@w.msgcli.net')) return 'whatsapp'
  if (userId.endsWith('@telegram')) return 'telegram'
  // Adicione mais canais depois
  return 'desconhecido'
}
