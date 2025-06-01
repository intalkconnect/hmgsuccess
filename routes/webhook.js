import dotenv from 'dotenv';
import { supabase } from '../services/db.js';
// Estamos usando o runFlow, que já acrescenta '@w.msgcli.net' internamente
import { runFlow } from '../chatbot/flowExecutor.js';
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

    // Ignora eventos de status (para não poluir o log)
    const hasStatusesOnly = !!body.entry?.[0]?.changes?.[0]?.value?.statuses;
    const hasMessages     = !!body.entry?.[0]?.changes?.[0]?.value?.messages;

    if (!hasMessages || hasStatusesOnly) {
      return reply.code(200).send('EVENT_RECEIVED');
    }

    console.log('📩 Webhook POST recebido:', JSON.stringify(body, null, 2));

    const entry       = body.entry[0].changes[0].value;
    const messages    = entry.messages;
    const contact     = entry.contacts?.[0];
    const from        = contact?.wa_id;               // ex.: "5521990286724"
    const profileName = contact?.profile?.name || 'usuário';

    if (messages && messages.length > 0 && from) {
      const msg      = messages[0];
      const msgId    = msg.id;
      const msgType  = msg.type;

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
        .eq('active', true)
        .limit(1)
        .single();

      // Prepara variáveis de sessão (aqui, rawUserId = from, sem suffix)
      const vars = {
        userPhone:        from,
        userName:         profileName,
        lastUserMessage:  userMessage,
        channel:          'whatsapp',
        now:              new Date().toISOString(),
        lastMessageId:    msgId
      };

      // ─── 1) Grava mensagem “incoming” na tabela `messages` ───
      //    o user_id fica no formato correto: `${from}@w.msgcli.net`
      const formattedUserId = `${from}@w.msgcli.net`;

      await supabase.from('messages').insert([{
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
      }]);
      // ──────────────────────────────────────────────────────────

      // 2) Processa a mensagem no engine (runFlow usará internamente o mesmo `${from}@w.msgcli.net`)
      const botResponse = await runFlow({
        message:    userMessage.toLowerCase(),
        flow:       latestFlow?.data,
        vars,
        rawUserId:  from        // runFlow na sua lógica monta `${rawUserId}@w.msgcli.net`
      });
      console.log('🤖 Resposta do bot:', botResponse);

      // A gravação da mensagem “outgoing” (bot → usuário)
      // já ocorre dentro do próprio runFlow (no flowExecutor.js),
      // portanto não precisamos gravar novamente aqui.
    }

    reply.code(200).send('EVENT_RECEIVED');
  });
}
