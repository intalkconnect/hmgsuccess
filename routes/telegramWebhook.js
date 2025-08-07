// routes/telegramWebhook.js

import dotenv from 'dotenv';
import { dbPool } from '../services/db.js';
import { runFlow } from '../chatbot/flowExecutor.js';

dotenv.config();

export default async function telegramWebhook(fastify) {
  const io = fastify.io;

  fastify.post('/', async (req, reply) => {
    const update = req.body;
    if (!update.message) return reply.send('IGNORADO');

    const msg = update.message;
    const from = msg.chat.id.toString();
    const profileName = msg.from?.username || msg.from?.first_name || 'usuário';
    const msgId = msg.message_id;
    const channel = 'telegram';
    const formattedUserId = `${from}@${channel}`;

    let msgType = 'text';
    let userMessage = '';
    let content = null;

    // Detecta tipo de mensagem
    if (msg.text) {
      userMessage = msg.text;
      content = msg.text;
    } else if (msg.photo) {
      msgType = 'photo';
      userMessage = '[imagem recebida]';
      content = JSON.stringify({
        file_id: msg.photo[msg.photo.length - 1].file_id,
        caption: msg.caption || '[imagem]',
      });
    } else if (msg.document) {
      msgType = 'document';
      userMessage = '[documento recebido]';
      content = JSON.stringify({
        file_id: msg.document.file_id,
        filename: msg.document.file_name || 'documento',
      });
    } else {
      userMessage = '[tipo não tratado]';
      content = userMessage;
    }

    console.log(`📩 Telegram (${msgType}) de ${formattedUserId}:`, userMessage);

    // Busca fluxo ativo
    const { rows: [latestFlow] } = await dbPool.query(`
      SELECT * FROM flows 
      WHERE active = true 
      LIMIT 1
    `);

    // Verifica/insere cliente
    const { rows: [existingClient] } = await dbPool.query(`
      SELECT id FROM clientes WHERE phone = $1 LIMIT 1
    `, [from]);

    if (!existingClient) {
      try {
        await dbPool.query(`
          INSERT INTO clientes (phone, name, channel, user_id, create_at)
          VALUES ($1, $2, $3, $4, $5)
        `, [from, profileName, channel, formattedUserId, new Date().toISOString()]);
        console.log('✅ Cliente Telegram salvo:', from);
      } catch (insertError) {
        console.error('❌ Erro ao salvar cliente Telegram:', insertError);
      }
    }

    const vars = {
      userPhone: from,
      userName: profileName,
      lastUserMessage: userMessage,
      now: new Date().toISOString(),
      lastMessageId: msgId,
      channel, // 👈 canal explícito aqui
    };

    try {
      // Grava a mensagem recebida
      const { rows: [insertedMessage] } = await dbPool.query(`
        INSERT INTO messages (
          user_id, message_id, direction, type, content,
          timestamp, flow_id, reply_to, status, metadata,
          created_at, updated_at, channel
        ) VALUES (
          $1, $2, 'incoming', $3, $4,
          $5, $6, null, 'received', null,
          $7, $8, $9
        ) RETURNING *
      `, [
        formattedUserId, msgId, msgType, content,
        new Date().toISOString(), latestFlow?.data?.id || null,
        new Date().toISOString(), new Date().toISOString(), channel,
      ]);

      // Emitir mensagem no socket
      if (io && insertedMessage) {
        io.emit('new_message', insertedMessage);
        io.to(`chat-${formattedUserId}`).emit('new_message', insertedMessage);
      }

      // Emitir status de bot processando
      if (io) {
        const statusPayload = {
          user_id: formattedUserId,
          status: 'processing',
        };
        io.emit('bot_processing', statusPayload);
        io.to(`chat-${formattedUserId}`).emit('bot_processing', statusPayload);
      }

      // Executa o fluxo
      const outgoingMessage = await runFlow({
        message: userMessage.toLowerCase(),
        flow: latestFlow?.data,
        vars,
        rawUserId: from,
        io,
      });

      if (io && outgoingMessage?.user_id) {
        io.emit('new_message', outgoingMessage);
        io.to(`chat-${formattedUserId}`).emit('new_message', outgoingMessage);
      } else {
        console.warn('⚠️ Nenhuma resposta emitida:', outgoingMessage);
      }

    } catch (error) {
      console.error('❌ Erro geral no webhook Telegram:', error);
    }

    return reply.code(200).send('EVENT_RECEIVED');
  });
}
