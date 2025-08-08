// services/sendTelegramMessage.js

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

export async function sendTelegramMessage({ chatId, type, content }) {
  let endpoint = '';
  let payload = { chat_id: chatId, ...content };

  switch (type) {
    case 'text':
      endpoint = '/sendMessage';
      break;
    case 'image':
      endpoint = '/sendPhoto';
      break;
    case 'audio':
      endpoint = content.voice ? '/sendVoice' : '/sendAudio';
      break;
    case 'video':
      endpoint = '/sendVideo';
      break;
    case 'document':
      endpoint = '/sendDocument';
      break;
    case 'location':
      endpoint = '/sendLocation';
      break;
    case 'interactive':
      endpoint = '/sendMessage';
      break;
    default:
      throw new Error(`Tipo de mensagem não suportado: ${type}`);
  }

  try {
    const response = await axios.post(`${TELEGRAM_API_URL}${endpoint}`, payload);
    return response.data;
  } catch (error) {
    console.error('Erro ao enviar mensagem para Telegram:', error.response?.data || error.message);
    throw error;
  }
}
