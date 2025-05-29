import dotenv from 'dotenv';
import { supabase } from '../services/db.js';
import { processMessage } from '../chatbot/engine.js';
dotenv.config();

export default async function webhookRoutes(fastify, opts) {
  fastify.get('/', async (req, reply) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === process.env.VERIFY_TOKEN) {
      return reply.code(200).send(challenge);
    }
    return reply.code(403).send('Forbidden');
  });

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

      // Buscar o último fluxo publicado
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

      const botResponse = processMessage(msgBody.toLowerCase(), latestFlow?.data, vars);
      console.log(`🤖 Resposta do bot:`, botResponse);

      await supabase.from('messages').insert([
        {
          user_id: from,
          message: msgBody,
          response: botResponse,
          created_at: new Date().toISOString()
        }
      ]);

      try {
        await fastify.inject({
          method: 'POST',
          url: `/messages/send`,
          payload: {
            to: from,
            type: 'text',
            content: { body: botResponse },
          },
        });
      } catch (err) {
        fastify.log.error('Erro ao enviar resposta do bot:', err);
      }
    } else {
      console.log('⚠️ Nenhuma mensagem ou remetente identificado no payload.');
    }

    reply.code(200).send('EVENT_RECEIVED');
  });
}
