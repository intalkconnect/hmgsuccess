// services/uploadMediaToWhatsapp.js
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

export async function uploadMediaToWhatsapp(filePath, mimeType) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('type', mimeType);
  form.append('messaging_product', 'whatsapp');

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          ...form.getHeaders(),
        },
      }
    );

    return response.data.id; // media_id
  } catch (error) {
    console.error('Erro ao fazer upload do arquivo:', error.response?.data || error.message);
    throw new Error('Falha no upload do arquivo para o WhatsApp.');
  }
}
