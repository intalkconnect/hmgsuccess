import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

/**
 * Envia mensagem para o Telegram
 * @param {Object} params
 * @param {string} params.chatId - ID do chat no Telegram
 * @param {string} params.type - Tipo de mensagem (text, image, audio, document, video)
 * @param {Object|string} params.content - Conteúdo da mensagem
 * @returns {Promise<Object>} Resposta da API do Telegram
 */
export async function sendTelegramMessage({ chatId, type, content }) {
  try {
    // Validações básicas
    if (!chatId) throw new Error('Chat ID é obrigatório');
    if (!type) throw new Error('Tipo de mensagem é obrigatório');
    if (!content) throw new Error('Conteúdo da mensagem é obrigatório');

    let payload = {
      chat_id: chatId,
      disable_notification: false,
    };

    // Tratamento por tipo de mensagem
    switch (type) {
      case 'text':
        if (typeof content !== 'string') {
          throw new Error('Conteúdo deve ser string para mensagens de texto');
        }
        if (!content.trim()) {
          throw new Error('Texto da mensagem não pode estar vazio');
        }
        payload.text = content;
        break;

      case 'image':
      case 'photo':
        payload.photo = content.url;
        if (content.caption) payload.caption = content.caption;
        if (content.filename) payload.filename = content.filename;
        break;

      case 'audio':
        payload.audio = content.url;
        if (content.caption) payload.caption = content.caption;
        if (content.duration) payload.duration = content.duration;
        break;

      case 'document':
        payload.document = content.url;
        if (content.caption) payload.caption = content.caption;
        if (content.filename) payload.filename = content.filename;
        break;

      case 'video':
        payload.video = content.url;
        if (content.caption) payload.caption = content.caption;
        if (content.duration) payload.duration = content.duration;
        if (content.width) payload.width = content.width;
        if (content.height) payload.height = content.height;
        break;

      default:
        throw new Error(`Tipo de mensagem não suportado: ${type}`);
    }

    // Determina o endpoint correto
    let endpoint;
    switch (type) {
      case 'text': endpoint = 'sendMessage'; break;
      case 'image':
      case 'photo': endpoint = 'sendPhoto'; break;
      case 'audio': endpoint = 'sendAudio'; break;
      case 'document': endpoint = 'sendDocument'; break;
      case 'video': endpoint = 'sendVideo'; break;
      default: endpoint = 'sendMessage';
    }

    console.log(`Enviando para Telegram (${endpoint}):`, payload);

    const response = await axios.post(`${TELEGRAM_API_URL}/${endpoint}`, payload);

    return {
      ok: true,
      message_id: response.data.result.message_id,
      date: response.data.result.date,
      chat: response.data.result.chat,
      ...response.data
    };

  } catch (error) {
    console.error('Erro ao enviar para Telegram:', {
      error: error.response?.data || error.message,
      payload: { chatId, type, content }
    });

    throw {
      ok: false,
      error_code: error.response?.data?.error_code || 500,
      description: error.response?.data?.description || error.message,
      originalError: error
    };
  }
}
