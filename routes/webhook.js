// src/routes/webhook.js
import dotenv from 'dotenv';
import { supabase } from '../services/db.js';
import { runFlow } from '../chatbot/flowExecutor.js';
import axios from 'axios';

dotenv.config();

export default async function webhookRoutes(fastify, opts) {
  const io = opts.io; // <- WebSocket passado via app.js

  // Verificação do Webhook
  fastify.get('/', async (req, reply) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === process.env.VERIFY_TOKEN) {
      return reply.code(200).send(challenge);
    }
    return reply.code(403).send('Forbidden');
  });

  // Processamento das mensagens recebidas
  fastify.post('/', async (req, reply) => {
    const body = req.body;

    const hasStatusesOnly = !!body.entry?.[0]?.changes?.[0]?.value?.statuses;
    const hasMessages     = !!body.entry?.[0]?.changes?.[0]?.value?.messages;

    if (!hasMessages || hasStatusesOnly) {
      return reply.code(200).send('EVENT_RECEIVED');
    }

    console.log('📩 Webhook POST recebido:', JSON.stringify(body, null, 2));

    const entry       = body.entry[0].changes[0].value;
    const messages    = entry.messages;
    const contact     = entry.contacts?.[0];
    const from        = contact?.wa_id;
    const profileName = contact?.profile?.name || 'usuário';

    if (messages && messages.length > 0 && from) {
      const msg      = messages[0];
      const msgId    = msg.id;
      const msgType  = msg.type;

      let userMessage = '';
      switch (msgType) {
        case 'text':
          userMessage = msg.text?.body || '';
          break;
        case 'interactive':
          if (msg.interactive.type === 'button_reply') {
            userMessage = msg.interactive.button_reply.id;
          } else if (msg.interactive.type === 'list_reply') {
            userMessage = msg.interactive.list_reply.id;
          }
          break;
        case 'image':
          userMessage = '[imagem recebida]';
          break;
        case 'video':
          userMessage = '[vídeo recebido]';
          break;
        case 'audio':
          userMessage = '[áudio recebido]';
          break;
        case 'document':
          userMessage = '[documento recebido]';
          break;
        case 'location': {
          const { latitude, longitude } = msg.location || {};
          userMessage = `📍 Localização recebida: ${latitude}, ${longitude}`;
          break;
        }
        default:
          userMessage = `[tipo não tratado: ${msgType}]`;
      }

      console.log(`🧾 Mensagem recebida de ${from} (${msgType} | id=${msgId}):`, userMessage);

      const { data: latestFlow } = await supabase
        .from('flows')
        .select('*')
        .eq('active', true)
        .limit(1)
        .single();

      const vars = {
        userPhone:        from,
        userName:         profileName,
        lastUserMessage:  userMessage,
        channel:          'whatsapp',
        now:              new Date().toISOString(),
        lastMessageId:    msgId
      };

      const formattedUserId = `${from}@w.msgcli.net`;

      // Grava a mensagem no banco
      const { data: insertedMessages } = await supabase.from('messages').insert([{
        user_id:             formattedUserId,
        whatsapp_message_id: msgId,
        direction:           'incoming',
        type:                msgType,
        content:             userMessage,
        timestamp:           new Date().toISOString(),
        flow_id:             latestFlow?.data?.id || null,
        agent_id:            null,
        queue_id:            null,
        status:              'received',
        metadata:            null,
        created_at:          new Date().toISOString(),
        updated_at:          new Date().toISOString()
      }]).select('*');

      // 🚀 Emit após gravação da incoming
      if (io && insertedMessages && insertedMessages.length > 0) {
        io.emit('new_message', insertedMessages[0]);
        io.to(`chat-${formattedUserId}`).emit('new_message', insertedMessages[0]);
      }

      // 🧠 Envia status de processamento opcional
      if (io) {
        io.emit('bot_processing', {
          user_id: formattedUserId,
          status: 'processing'
        });
        io.to(`chat-${formattedUserId}`).emit('bot_processing', {
          user_id: formattedUserId,
          status: 'processing'
        });
      }

      const botResponse = await runFlow({
        message:    userMessage.toLowerCase(),
        flow:       latestFlow?.data,
        vars,
        rawUserId:  from
      });

      console.log('🤖 Resposta do bot:', botResponse);

      // 🚀 Emit resposta do bot
      if (io) {
        io.emit('bot_response', {
          user_id: formattedUserId,
          response: botResponse
        });
        io.to(`chat-${formattedUserId}`).emit('bot_response', {
          user_id: formattedUserId,
          response: botResponse
        });
      }
    }

    return reply.code(200).send('EVENT_RECEIVED');
  });
}
