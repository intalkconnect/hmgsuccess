import axios from 'axios';
import dotenv from 'dotenv';
import { uploadMediaToWhatsapp } from './wa/uploadMediaToWhatsapp.js';
dotenv.config();

const {
  API_VERSION,
  PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: ACCESS_TOKEN
} = process.env;

/**
 * Chama Graph API para marcar como lida + typing indicator,
 * usando diretamente o messageId fornecido.
 */
export async function markAsReadAndTyping(messageId) {
  if (!messageId) return;

  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
    typing_indicator: { type: 'text' }
  };

  await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

/**
 * Envia mensagem via WhatsApp Cloud API.
 * Agora aceita opcionalmente `messageId` para fechar o typing.
 */
export async function sendWhatsappMessage({ to, type, content, messageId }) {
  // Monta o payload normal
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type
  };

  if (['image', 'audio', 'video', 'document'].includes(type)) {
    const mediaId = await uploadMediaToWhatsapp(content.url, type);
    payload[type] = {
      id: mediaId,
      caption: content.caption
    };
  } else if (type === 'location') {
    payload[type] = {
      latitude:  content.latitude,
      longitude: content.longitude,
      name:      content.name,
      address:   content.address
    };
  } else {
    payload[type] = content;
  }

  // Envia a mensagem real pelo Graph API
  try {
    const res = await axios.post(
      `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
      }
    );
    return res.data;
  } catch (err) {
    console.error('❌ erro ao enviar mensagem:', err.response?.data || err.message);
    throw err;
  }
}
