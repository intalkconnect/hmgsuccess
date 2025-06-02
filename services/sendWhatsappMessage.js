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

export async function sendWhatsappMessage({ to, type, content, messageId }) {

  await sendTypingIndicator(to);

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
