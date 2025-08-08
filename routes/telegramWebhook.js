// routes/telegramWebhook.js

import dotenv from 'dotenv';
import { dbPool } from '../services/db.js';
import { runFlow } from '../engine/flowExecutor.js';
import axios from 'axios';
import { uploadToMinio } from '../services/uploadToMinio.js';

dotenv.config();

export default async function telegramWebhook(fastify) {
  const io = fastify.io;

  fastify.post('/', async (req, reply) => {
    const update = req.body;
    
    // Processa apenas mensagens de texto e comandos
    if (!update.message && !update.callback_query) {
      return reply.code(200).send('OK');
    }

    const message = update.message || update.callback_query.message;
    const from = update.message?.from || update.callback_query?.from;
    const chatId = message.chat.id;
    const userId = `${chatId}@t.msgcli.net`; // Padrão similar ao WhatsApp
    const isCallback = !!update.callback_query;

    let userMessage = '';
    let content = '';
    let msgType = 'text';

    if (isCallback) {
      userMessage = update.callback_query.data;
      msgType = 'interactive';
      content = userMessage;
    } else if (message.text) {
      userMessage = message.text;
      content = userMessage;
    } else if (message.photo) {
      msgType = 'image';
      userMessage = '[imagem recebida]';
      // Pega a foto de maior resolução (última do array)
      const photo = message.photo[message.photo.length - 1];
      const fileUrl = await getTelegramFileUrl(photo.file_id);
      content = { url: fileUrl, caption: message.caption || '' };
    } else if (message.audio) {
      msgType = 'audio';
      userMessage = '[áudio recebido]';
      const fileUrl = await getTelegramFileUrl(message.audio.file_id);
      content = { url: fileUrl, isVoice: false };
    } else if (message.voice) {
      msgType = 'audio';
      userMessage = '[mensagem de voz recebida]';
      const fileUrl = await getTelegramFileUrl(message.voice.file_id);
      content = { url: fileUrl, isVoice: true };
    } else if (message.video) {
      msgType = 'video';
      userMessage = '[vídeo recebido]';
      const fileUrl = await getTelegramFileUrl(message.video.file_id);
      content = { url: fileUrl, caption: message.caption || '' };
    } else if (message.document) {
      msgType = 'document';
      userMessage = '[documento recebido]';
      const fileUrl = await getTelegramFileUrl(message.document.file_id);
      content = { url: fileUrl, filename: message.document.file_name || '' };
    } else if (message.location) {
      msgType = 'location';
      userMessage = '📍 Localização recebida';
      content = {
        latitude: message.location.latitude,
        longitude: message.location.longitude
      };
    }

    console.log(`🧾 Mensagem recebida do Telegram (${msgType} | chatId=${chatId}):`, userMessage);

    // Busca o fluxo ativo
    const { rows: [latestFlow] } = await dbPool.query(`
      SELECT * FROM flows 
      WHERE active = true 
      LIMIT 1
    `);

    // Verifica e insere cliente
    const { rows: [existingClient] } = await dbPool.query(`
      SELECT id FROM clientes 
      WHERE user_id = $1 
      LIMIT 1
    `, [userId]);

    if (!existingClient) {
      try {
        await dbPool.query(`
          INSERT INTO clientes (phone, name, channel, user_id, create_at)
          VALUES ($1, $2, $3, $4, $5)
        `, [
          chatId.toString(),
          `${from.first_name} ${from.last_name || ''}`.trim(),
          'telegram',
          userId,
          new Date().toISOString()
        ]);
        console.log('✅ Cliente Telegram salvo:', userId);
      } catch (insertError) {
        console.error('❌ Erro ao salvar cliente Telegram:', insertError);
      }
    }

    const vars = {
      userPhone: chatId.toString(),
      userName: `${from.first_name} ${from.last_name || ''}`.trim(),
      lastUserMessage: userMessage,
      channel: 'telegram',
      now: new Date().toISOString()
    };

    // Insere mensagem no banco
    try {
      const { rows: [insertedMessage] } = await dbPool.query(`
        INSERT INTO messages (
          user_id, message_id, direction, type, content,
          timestamp, flow_id, status,
          created_at, updated_at, channel
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8,
          $9, $10, $11
        ) RETURNING *
      `, [
        userId,
        message.message_id.toString(),
        'incoming',
        msgType,
        typeof content === 'string' ? content : JSON.stringify(content),
        new Date().toISOString(),
        latestFlow?.data?.id || null,
        'received',
        new Date().toISOString(),
        new Date().toISOString(),
        'telegram'
      ]);

      if (io && insertedMessage) {
        setTimeout(() => {
          console.log('📡 Emitindo new_message (incoming Telegram):', insertedMessage);
          io.emit('new_message', insertedMessage);
          io.to(`chat-${userId}`).emit('new_message', insertedMessage);
        }, 200);
      }

      // Executa o fluxo do bot
      const outgoingMessage = await runFlow({
        message: userMessage.toLowerCase(),
        flow: latestFlow?.data,
        vars,
        rawUserId: chatId.toString(),
        io
      });

      // Emite resposta do bot
      if (io && outgoingMessage?.user_id) {
        console.log('📡 Emitindo new_message (outgoing Telegram):', outgoingMessage);
        io.emit('new_message', outgoingMessage);
        io.to(`chat-${userId}`).emit('new_message', outgoingMessage);
      }

    } catch (error) {
      console.error('❌ Erro ao gravar mensagem Telegram:', error);
    }

    return reply.code(200).send('OK');
  });

  async function getTelegramFileUrl(fileId) {
    try {
      const response = await axios.get(
        `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
      );
      const filePath = response.data.result.file_path;
      return `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${filePath}`;
    } catch (error) {
      console.error('Erro ao obter URL do arquivo do Telegram:', error);
      throw error;
    }
  }
}
