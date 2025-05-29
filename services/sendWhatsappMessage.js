import axios from 'axios';
import dotenv from 'dotenv';
import { supabase } from '../services/db.js';
import { uploadMediaToWhatsapp } from './wa/uploadMediaToWhatsapp.js';
dotenv.config();

const {
  API_VERSION,
  PHONE_NUMBER_ID,
  WHATSAPP_TOKEN: ACCESS_TOKEN
} = process.env;

/**
 * 1) Busca na sessão o último message_id recebido para este usuário
 * 2) Chama Graph API para marcar como lida + typing indicator
 */
async function markAsReadAndTyping(to) {
  const { data: session } = await supabase
    .from('sessions')
    .select('last_whatsapp_message_id')
    .eq('user_id', `${to}@c.wa.msginb.net`)
    .single();

  const lastId = session?.last_whatsapp_message_id;
  if (!lastId) return;

  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: lastId,
    typing_indicator: { type: 'text' }
  };

  await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

export async function sendWhatsappMessage({ to, type, content }) {
  // 🚨 Antes de montar o payload, dispara read+typing
  try {
    await markAsReadAndTyping(to);
    console.log(`✓ markAsReadAndTyping enviado para ${to}`);
  } catch (err) {
    console.error('❌ erro no read+typing:', err.response?.data || err.message);
  }

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
