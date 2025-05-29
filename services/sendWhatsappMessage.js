// services/sendWhatsappMessage.js
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

export async function sendWhatsappMessage({ to, type, content }) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type,
    [type]: content,
  };

  const res = await axios.post(
    `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`,
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
