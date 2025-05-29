import dotenv from 'dotenv';
import { supabase } from '../services/db.js';
import { processMessage } from '../chatbot/engine.js';
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

    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    const contact  = body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
    const from     = contact?.wa_id;
    const profileName = contact?.profile?.name || 'usuário';

    if (messages && messages.length > 0 && from) {
      const msg      = messages[0];
      const msgId    = msg.id;                    // <-- extraímos o message_id
      let msgBody    = '';
      let msgType    = msg.type;

      switch (msgType) {
        case 'text':
          msgBody = msg.text?.body || '';
          break;
        case 'image':
          msgBody = '[imagem recebida]';
          break;
        case 'video':
          msgBody = '[vídeo recebido]';
          break;
        case 'audio':
          msgBody = '[áudio recebido]';
          break;
        case 'document':
          msgBody = '[documento recebido]';
          break;
        case 'location':
          const { latitude, longitude } = msg.location || {};
          msgBody = `📍 Localização recebida: ${latitude}, ${longitude}`;
          break;
        default:
          msgBody = `[tipo de mensagem não tratado: ${msgType}]`;
      }

      console.log(`🧾 Mensagem recebida de ${from} (${msgType} | id=${msgId}):`, msgBody);

      // Carrega o último fluxo publicado
      const { data: latestFlow } = await supabase
        .from('flows')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      const vars = {
        userPhone: from,
        userName: profileName,
        userMessage: msgBody,
        channel: 'whatsapp',
        now: new Date().toISOString(),
        lastMessageId: msgId,      // se quiser passar também para a engine
      };

      const botResponse = await processMessage(
        msgBody.toLowerCase(),
        latestFlow?.data,
        vars,
        from
      );
      console.log(`🤖 Resposta do bot:`, botResponse);

      // Salva a mensagem no histórico, agora incluindo whatsapp_message_id
      await supabase
        .from('messages')
        .insert([
          {
            user_id:             from,
            whatsapp_message_id: msgId,
            type:                msgType,
            message:             msgBody,
            response:            botResponse,
            created_at:          new Date().toISOString(),
          },
        ]);
    } else {
      console.log('⚠️ Nenhuma mensagem ou remetente identificado no payload.');
    }

    reply.code(200).send('EVENT_RECEIVED');
  });
}
