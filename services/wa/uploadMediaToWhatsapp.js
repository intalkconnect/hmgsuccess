// src/services/whatsappMedia.js

import axios from 'axios';
import FormData from 'form-data';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Tipos válidos de mídia para upload no WhatsApp Cloud API.
 * - image    => imagens JPEG, PNG, etc.
 * - audio    => arquivos de áudio (OGG, MP3, etc.)
 * - document => PDFs, DOCX, XLSX, etc.
 */
const VALID_WHATSAPP_MEDIA_TYPES = ['image', 'audio', 'document'];

/**
 * Faz download de um arquivo (imagem, áudio ou documento) a partir de `fileUrl`
 * e faz upload desse stream para o WhatsApp Cloud API (endpoint /v17.0/<PHONE_NUMBER_ID>/media),
 * retornando o `media_id` gerado pelo WhatsApp.
 *
 * @param {string} fileUrl - URL pública do arquivo a ser enviado (pode ser PNG/JPEG, OGG/MP3, PDF, etc.)
 * @param {'image'|'audio'|'document'} type - Tipo de mídia para o WhatsApp (`image`, `audio` ou `document`)
 * @returns {Promise<string>} - Promise que resolve com o `media_id` retornado pelo WhatsApp
 * @throws {Error} - Se o `type` for inválido, ou se houver falha ao baixar/uploadar o arquivo
 */
export async function uploadMediaToWhatsapp(fileUrl, type = 'image') {
  // 1) Verifica se o type passado é válido
  if (!VALID_WHATSAPP_MEDIA_TYPES.includes(type)) {
    throw new Error(
      `[uploadMediaToWhatsapp] Tipo de mídia inválido: "${type}". ` +
      `Use um dos valores: ${VALID_WHATSAPP_MEDIA_TYPES.join(', ')}.`
    );
  }

  try {
    // 2) Faz GET da URL para obter um stream do arquivo
    const response = await axios.get(fileUrl, { responseType: 'stream' });
    const fileName = path.basename(fileUrl);

    // 3) Prepara o FormData para o POST ao endpoint /media
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', type);

    // 4) Adiciona o stream do arquivo (response.data) ao FormData
    form.append('file', response.data, {
      filename: fileName,
      // Se o header não informar content-type, usa application/octet-stream
      contentType: response.headers['content-type'] || 'application/octet-stream'
    });

    // 5) Envia a requisição POST para o WhatsApp Cloud API
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
    return res.data.id; // Retorna o media_id
  } catch (err) {
    console.error('[❌ uploadMediaToWhatsapp] Erro:', err.response?.data || err.message);
    throw new Error('Erro ao subir mídia para o WhatsApp');
  }
}
