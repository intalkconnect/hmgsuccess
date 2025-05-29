import dotenv from 'dotenv';
import { supabase } from '../services/db.js';
import { processMessage } from '../chatbot/engine.js';
import { substituteVariables } from '../utils/vars.js';
dotenv.config();

export default async function webhookRoutes(fastify, opts) {
  // Verificação do Webhook (GET)
  fastify.get('/', async (req, reply) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === process.env.VERIFY_TOKEN) {
      return reply.code(200).send(challenge);
    }
    return reply.code(403).send('Forbidden');
  });

  // Recebimento de mensagens (POST)
  fastify.post('/', async (req, reply) => {
    const body = req.body;
    console.log('📩 Webhook POST recebido:', JSON.stringify(body, null, 2));
    fastify.log.info('Mensagem recebida:', body);

    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    const contact = body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
    const from = contact?.wa_id;
    const profileName = contact?.profile?.name || 'usuário';

    if (messages && messages.length > 0 && from) {
      const msgBody = messages[0].text?.body || '';
      console.log(`🧾 Mensagem recebida de ${from}:`, msgBody);

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
        now: new Date().toISOString(),
      };

      // Processa a mensagem no motor
      const botResponse = await processMessage(
        msgBody.toLowerCase(),
        latestFlow?.data,
        vars,
        from
      );
      console.log(`🤖 Resposta do bot:`, botResponse);

      // Salva no histórico (mesmo que processMessage envie as mensagens)
      await supabase.from('messages').insert([
        {
          user_id: from,
          message: msgBody,
          response: botResponse,
          created_at: new Date().toISOString(),
        },
      ]);
    } else {
      console.log('⚠️ Nenhuma mensagem ou remetente identificado no payload.');
    }

    reply.code(200).send('EVENT_RECEIVED');
  });
}
