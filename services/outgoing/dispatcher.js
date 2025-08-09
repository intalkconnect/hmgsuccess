import { sendViaWhatsApp } from './senders/whatsappSender.js';
import { sendViaTelegram } from './senders/telegramSender.js';

export async function dispatchOutgoing(msg) {
  try {
    switch (msg.channel) {
      case 'whatsapp':
        return await sendViaWhatsApp(msg);
      case 'telegram':
        return await sendViaTelegram(msg);
      default:
        return { ok: false, retry: false, reason: `Canal não suportado: ${msg.channel}` };
    }
  } catch (e) {
    // erro não categorizado: trate como retry
    return { ok: false, retry: true, reason: e?.message || e };
  }
}
