// services/sendWhatsappMessage.js
import axios from 'axios';
import dotenv from 'dotenv';
import { uploadMediaToWhatsapp } from './wa/uploadMediaToWhatsapp.js';
import { sendTypingIndicator } from './wa/sendTypingIndicator.js';

dotenv.config();

const {
  API_VERSION = 'v22.0',
  PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: ACCESS_TOKEN,
} = process.env;

// --------- Guard rails: falhar cedo e claro ----------
function assertEnvs() {
  const missing = [];
  if (!API_VERSION) missing.push('API_VERSION');
  if (!PHONE_NUMBER_ID) missing.push('PHONE_NUMBER_ID');
  if (!ACCESS_TOKEN) missing.push('WHATSAPP_TOKEN');
  if (missing.length) {
    const msg = `[WABA] Variáveis ausentes: ${missing.join(', ')}. ` +
      `Confira seu .env e as configs do ambiente (build/deploy).`;
    throw new Error(msg);
  }
}

function normalizeWaTo(to) {
  if (!to) return to;
  // remove sufixo interno do seu sistema
  const cleaned = String(to).replace(/@w\.msgcli\.net$/i, '');
  // mantém só dígitos
  const digits = cleaned.replace(/\D/g, '');
  return digits;
}

function isE164(num) {
  return /^\d{7,15}$/.test(num); // regra simples: 7–15 dígitos
}

export async function sendWhatsappMessage({ to, type, content, context }) {
  assertEnvs();

  const toNormalized = normalizeWaTo(to);
  if (!isE164(toNormalized)) {
    throw new Error(`[WABA] Destinatário inválido para Cloud API: "${to}". ` +
      `Use apenas dígitos com DDI/DDD, ex: 5521999998888`);
  }

  console.log('📨 [sendWhatsappMessage] Iniciando envio...');
  console.log('📍 Destinatário (normalizado):', toNormalized);
  console.log('📝 Tipo:', type);
  console.log('📦 Conteúdo (adaptado):', content);
  if (context) console.log('↩️ Context:', context);

  const payload = {
    messaging_product: 'whatsapp',
    to: toNormalized,
    type,
  };

  if (context?.message_id) {
    payload.context = { message_id: context.message_id };
  }

  try {
    if (['image', 'audio', 'video', 'document'].includes(type)) {
      console.log('📤 Subindo mídia para o WhatsApp...');
      const mediaId = await uploadMediaToWhatsapp(content.url, type);
      if (!mediaId) throw new Error('Upload de mídia falhou — mediaId indefinido');

      payload[type] = { id: mediaId };
      if (type === 'audio' && content.voice === true) payload[type].voice = true;
      if (content.caption) payload[type].caption = content.caption;

    } else if (type === 'location') {
      payload[type] = {
        latitude: content.latitude,
        longitude: content.longitude,
        name: content.name,
        address: content.address,
      };

    } else {
      // text | interactive | etc. — já deve vir adaptado pelo MessageAdapter
      payload[type] = content;
    }

    console.log('📦 Payload final:', JSON.stringify(payload, null, 2));

    const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
    const res = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      // timeout opcional:
      timeout: 15000,
    });

    console.log('✅ Mensagem enviada com sucesso:', res.data);
    return res.data;

  } catch (err) {
    // Logs mais legíveis
    const status = err.response?.status;
    const data = err.response?.data;
    console.error(`❌ Erro ao enviar mensagem (status ${status ?? 'N/A'}):`,
      data?.error || err.message);
    throw err;
  }
}
