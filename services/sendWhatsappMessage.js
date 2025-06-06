import axios from 'axios';
import dotenv from 'dotenv';
import { uploadMediaToWhatsapp } from './wa/uploadMediaToWhatsapp.js';
import { sendTypingIndicator } from './wa/sendTypingIndicator.js';

dotenv.config();

const {
  API_VERSION,
  PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: ACCESS_TOKEN
} = process.env;

/**
 * Envia mensagem via WhatsApp Cloud API com logs detalhados.
 */
export async function sendWhatsappMessage({ to, type, content, context }) {
  console.log('📨 [sendWhatsappMessage] Iniciando envio...');
  console.log('📍 Destinatário:', to);
  console.log('📝 Tipo:', type);
  console.log('📦 Conteúdo inicial:', content, context);

  // // Envia indicador de digitação (se messageId presente)
  // if (messageId) {
  //   console.log('✍️ Enviando indicador de digitação...');
  //   await sendTypingIndicator(messageId);
  // }

  // Monta o payload base
const payload = {
  messaging_product: 'whatsapp',
  to,
  type,
};

// Adiciona `context` somente se existir
if (context) {
  payload.context = context;
}

console.log('📤 Payload final a ser enviado:', payload);

  try {
   if (['image', 'audio', 'video', 'document'].includes(type)) {
  console.log(`📤 Subindo mídia para o WhatsApp...`);
  const mediaId = await uploadMediaToWhatsapp(content.url, type);
  console.log(`✅ Mídia enviada. ID: ${mediaId}`);

  payload[type] = {
    id: mediaId,
    filename: content.filename || 'documento.pdf'
  };

  // 🔥 Se for áudio tipo "voice message" (PTT)
  if (type === 'audio' && content.voice === true) {
    payload[type].voice = true;
  }

  // if (content.caption) {
  //   payload[type].caption = content.caption;
  // }

} else if (type === 'location') {
  payload[type] = {
    latitude: content.latitude,
    longitude: content.longitude,
    name: content.name,
    address: content.address
  };
} else {
  payload[type] = content;
}


    console.log('📦 Payload final para envio:', JSON.stringify(payload, null, 2));

    const res = await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Mensagem enviada com sucesso:', res.data);
    return res.data;

  } catch (err) {
    console.error('❌ Erro ao enviar mensagem:', err.response?.data || err.message);
    throw err;
  }
}
