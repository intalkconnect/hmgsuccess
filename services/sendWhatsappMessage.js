import axios from 'axios';
import dotenv from 'dotenv';
import { uploadMediaToWhatsapp } from './wa/uploadMediaToWhatsapp.js';
dotenv.config();

export async function sendWhatsappMessage({ to, type, content }) {
  let payload = {
    messaging_product: 'whatsapp',
    to,
    type,
  };

  // Tratamento especial para tipos com upload
  if (['image', 'audio', 'video', 'document'].includes(type)) {
    const mediaId = await uploadMediaToWhatsapp(content.url, type);
    payload[type] = {
      id: mediaId,
      caption: content.caption || undefined,
    };
  } else if (type === 'location') {
    payload[type] = {
      latitude: content.latitude,
      longitude: content.longitude,
      name: content.name,
      address: content.address,
    };
  } else {
    payload[type] = content;
  }

  const res = await axios.post(
    `https://graph.facebook.com/${process.env.API_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return res.data;
}
