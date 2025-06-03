import axios from 'axios';
import FormData from 'form-data';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs';
import tmp from 'tmp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

dotenv.config();

ffmpeg.setFfmpegPath(ffmpegPath);

const VALID_WHATSAPP_MEDIA_TYPES = ['image', 'audio', 'document'];

export async function uploadMediaToWhatsapp(fileUrl, type = 'image') {
  if (!VALID_WHATSAPP_MEDIA_TYPES.includes(type)) {
    throw new Error(`[uploadMediaToWhatsapp] Tipo de mídia inválido: "${type}". Use: ${VALID_WHATSAPP_MEDIA_TYPES.join(', ')}.`);
  }

  try {
    const response = await axios.get(fileUrl, { responseType: 'stream' });
    const ext = path.extname(fileUrl);
    const originalFile = tmp.fileSync({ postfix: ext });
    const writeStream = fs.createWriteStream(originalFile.name);

    // 1) Salva o arquivo temporariamente
    await new Promise((resolve, reject) => {
      response.data.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    let finalFilePath = originalFile.name;
    let finalMime = response.headers['content-type'];

    // 2) Se for áudio, converte para MP3
    if (type === 'audio') {
      const mp3Temp = tmp.fileSync({ postfix: '.mp3' });
      await new Promise((resolve, reject) => {
        ffmpeg(originalFile.name)
          .audioCodec('libmp3lame')
          .format('mp3')
          .audioChannels(1) // WhatsApp requer canal único
          .on('end', resolve)
          .on('error', reject)
          .save(mp3Temp.name);
      });
      finalFilePath = mp3Temp.name;
      finalMime = 'audio/mpeg';
    }

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', type);
    form.append('file', fs.createReadStream(finalFilePath), {
      filename: path.basename(finalFilePath),
      contentType: finalMime
    });

    const res = await axios.post(
      `https://graph.facebook.com/v17.0/${process.env.PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
        }
      }
    );

    console.log('[✅ uploadMediaToWhatsapp] Upload bem-sucedido:', res.data);
    return res.data.id;
  } catch (err) {
    console.error('[❌ uploadMediaToWhatsapp] Erro:', err.response?.data || err.message);
    throw new Error('Erro ao subir mídia para o WhatsApp');
  }
}
