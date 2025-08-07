// routes/telegramWebhook.js
import { dbPool } from '../services/db.js';
import { runFlow } from '../chatbot/flowExecutor.js';
import { makeUserId, normalizeChannel } from '../utils/identity.js';

export default async function telegramWebhook(fastify) {
  const io = fastify.io;

  fastify.post('/', async (req, reply) => {
    const update = req.body;
    if (!update?.message) return reply.send('IGNORADO');

    const msg = update.message;
    const from = String(msg.chat.id); // chat id do Telegram
    const profileName = msg.from?.username || msg.from?.first_name || 'usuário';
    const msgId = msg.message_id;
    const channel = normalizeChannel('telegram'); // "telegram"
    const formattedUserId = makeUserId(from, channel); // "<chatId>@telegram"

    let msgType = 'text';
    let userMessage = '';
    let content = null;

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

    // 🔐 Garante cliente com canal/user_id corretos
    try {
      await dbPool.query(
        `
        INSERT INTO clientes (user_id, phone, name, channel, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (user_id) DO UPDATE
          SET phone = EXCLUDED.phone,
              name = COALESCE(NULLIF(EXCLUDED.name, ''), clientes.name),
              channel = EXCLUDED.channel
        `,
        [formattedUserId, from, profileName, channel]
      );
    } catch (e) {
      fastify.log.error('Erro upsert cliente Telegram:', e);
    }

    const vars = {
      userPhone: from,
      userName: profileName,
      lastUserMessage: userMessage,
      now: new Date().toISOString(),
      lastMessageId: msgId,
      channel,
    };

    try {
      // 🔐 Grava mensagem com channel e user_id corretos
      const { rows: [insertedMessage] } = await dbPool.query(
        `
        INSERT INTO messages (
          user_id, message_id, direction, type, content,
          timestamp, flow_id, reply_to, status, metadata,
          created_at, updated_at, channel
        ) VALUES (
          $1, $2, 'incoming', $3, $4,
          NOW(), NULL, NULL, 'received', NULL,
          NOW(), NOW(), $5
        )
        ON CONFLICT DO NOTHING
        RETURNING *
        `,
        [formattedUserId, String(msgId), msgType, content, channel]
      );

      if (io && insertedMessage) {
        io.emit('new_message', insertedMessage);
        io.to(`chat-${formattedUserId}`).emit('new_message', insertedMessage);
      }

      // status de processamento
      io?.emit('bot_processing', { user_id: formattedUserId, status: 'processing' });
      io?.to(`chat-${formattedUserId}`).emit('bot_processing', { user_id: formattedUserId, status: 'processing' });

      // Executa o fluxo — **garanta** que o retorno preserve user_id/channel
      const outgoingMessage = await runFlow({
        message: userMessage.toLowerCase(),
        flow: null, // ou latestFlow?.data
        vars,
        rawUserId: from,
        io,
      });

      if (io && outgoingMessage?.user_id) {
        // Se o fluxo não definiu user_id, força:
        if (!outgoingMessage.channel) outgoingMessage.channel = channel;
        if (!outgoingMessage.user_id) outgoingMessage.user_id = formattedUserId;

        io.emit('new_message', outgoingMessage);
        io.to(`chat-${formattedUserId}`).emit('new_message', outgoingMessage);
      }

    } catch (error) {
      fastify.log.error('Erro geral no webhook Telegram:', error);
    }

    return reply.code(200).send('EVENT_RECEIVED');
  });
}
