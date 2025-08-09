// services/high/processFileHeavy.js (ESM)
import axios from 'axios';
import { uploadToMinio } from '../uploadToMinio.js'; // ajuste se necessário

async function waDownloadMedia(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  const meta = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const mediaUrl = meta.data?.url;

  const res = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${token}` }
  });

  const mime = res.headers['content-type'] || 'application/octet-stream';
  return { buffer: res.data, mime };
}

async function tgGetFileUrl(fileId) {
  const res = await axios.get(
    `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
  );
  const filePath = res.data?.result?.file_path;
  return `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${filePath}`;
}

export async function processMediaIfNeeded(channel, ctx) {
  if (channel === 'whatsapp') {
    const { value, msg } = ctx;
    const type = msg?.type;

    if (type === 'text') {
      const text = msg.text?.body || '';
      return { content: text, userMessage: text, msgType: 'text' };
    }
    if (type === 'interactive') {
      const choice = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || '';
      return { content: choice, userMessage: choice, msgType: 'interactive' };
    }
    if (['image','video','audio','document','sticker'].includes(type)) {
      try {
        const mediaId = msg[type]?.id;
        const { buffer, mime } = await waDownloadMedia(mediaId);
        const ext = (mime.split('/')[1] || 'bin').split(';')[0];
        const filename = `${type}-${mediaId}.${ext}`;
        const url = await uploadToMinio(buffer, filename, mime);

        if (type === 'audio') {
          return { content: JSON.stringify({ url }), userMessage: '[áudio recebido]', msgType: 'audio' };
        }
        if (type === 'document') {
          const fname = msg.document?.filename || filename;
          return { content: JSON.stringify({ url, filename: fname }), userMessage: '[documento recebido]', msgType: 'document' };
        }
        if (type === 'image' || type === 'video' || type === 'sticker') {
          const caption = msg.caption || filename;
          return { content: JSON.stringify({ url, caption }), userMessage: `[${type} recebido]`, msgType: type };
        }
      } catch (e) {
        console.error('❌ WA mídia erro:', e?.message || e);
        return { content: '[mídia erro]', userMessage: '[mídia erro]', msgType: type || 'media' };
      }
    }
    if (type === 'location') {
      const { latitude, longitude } = msg.location || {};
      const text = `📍 ${latitude}, ${longitude}`;
      return { content: text, userMessage: text, msgType: 'location' };
    }
    return { content: `[tipo não tratado: ${type}]`, userMessage: `[tipo não tratado: ${type}]`, msgType: type || 'unknown' };
  }

  if (channel === 'telegram') {
    const { update, message } = ctx;

    if (update?.callback_query?.data) {
      const data = update.callback_query.data;
      return { content: data, userMessage: data, msgType: 'interactive' };
    }
    if (message?.text) {
      return { content: message.text, userMessage: message.text, msgType: 'text' };
    }
    if (message?.photo) {
      const f = message.photo[message.photo.length - 1];
      const url = await tgGetFileUrl(f.file_id);
      return { content: JSON.stringify({ url, caption: message.caption || '' }), userMessage: '[imagem recebida]', msgType: 'image' };
    }
    if (message?.video) {
      const url = await tgGetFileUrl(message.video.file_id);
      return { content: JSON.stringify({ url, caption: message.caption || '' }), userMessage: '[vídeo recebido]', msgType: 'video' };
    }
    if (message?.document) {
      const url = await tgGetFileUrl(message.document.file_id);
      return { content: JSON.stringify({ url, filename: message.document.file_name || '' }), userMessage: '[documento recebido]', msgType: 'document' };
    }
    if (message?.voice) {
      const url = await tgGetFileUrl(message.voice.file_id);
      return { content: JSON.stringify({ url, isVoice: true }), userMessage: '[voz recebida]', msgType: 'audio' };
    }
    if (message?.audio) {
      const url = await tgGetFileUrl(message.audio.file_id);
      return { content: JSON.stringify({ url, isVoice: false }), userMessage: '[áudio recebido]', msgType: 'audio' };
    }
    if (message?.location) {
      const text = `📍 ${message.location.latitude}, ${message.location.longitude}`;
      return { content: text, userMessage: text, msgType: 'location' };
    }
    return { content: '[tipo não tratado]', userMessage: '[tipo não tratado]', msgType: 'unknown' };
  }

  return { content: '', userMessage: '', msgType: 'text' };
}
