import dotenv from 'dotenv';
import { supabase } from '../services/db.js';
import { processMessage } from '../chatbot/index.js';
import axios from 'axios';

dotenv.config();

export default async function webhookRoutes(fastify, opts) {
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

    // Ignora eventos de status (para evitar poluir o log)
    const hasStatusesOnly = !!body.entry?.[0]?.changes?.[0]?.value?.statuses;
    const hasMessages     = !!body.entry?.[0]?.changes?.[0]?.value?.messages;

    if (!hasMessages || hasStatusesOnly) {
      return reply.code(200).send('EVENT_RECEIVED');
    }

    console.log('📩 Webhook POST recebido:', JSON.stringify(body, null, 2));

    const entry    = body.entry[0].changes[0].value;
    const messages = entry.messages;
    const contact  = entry.contacts?.[0];
    const from     = contact?.wa_id;
    const profileName = contact?.profile?.name || 'usuário';

    if (messages && messages.length > 0 && from) {
      const msg   = messages[0];
      const msgId = msg.id;
      const msgType = msg.type;

      // Normaliza payload do usuário para texto simples ou ID de interactive
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

      // Carrega o último fluxo publicado
      const { data: latestFlow } = await supabase
        .from('flows')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      // Prepara variáveis de sessão
      const vars = {
        userPhone:     from,
        userName:      profileName,
        lastUserMessage: userMessage,
        channel:       'whatsapp',
        now:           new Date().toISOString(),
        lastMessageId: msgId
      };

      // Processa a mensagem no engine
      const botResponse = await processMessage(
        userMessage.toLowerCase(),
        latestFlow?.data,
        vars,
        from
      );
      console.log('🤖 Resposta do bot:', botResponse);

      // Salva no histórico
      await supabase.from('messages').insert([{
        user_id:             from,
        whatsapp_message_id: msgId,
        type:                msgType,
        message:             userMessage,
        response:            botResponse,
        created_at:          new Date().toISOString()
      }]);
    }

    reply.code(200).send('EVENT_RECEIVED');
  });
}
