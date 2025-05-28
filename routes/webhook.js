import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { processMessage } from '../chatbot/engine.js';
import { supabase } from '../services/db.js';
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
    fastify.log.info('Mensagem recebida:', body);

    const messages = body.entry?.[0]?.changes?.[0]?.value?.messages;
    const from = body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.wa_id;
    const timestamp = messages?.[0]?.timestamp;

    if (messages && messages.length > 0 && from) {
      const msgBody = messages[0].text?.body || '';

      const flowPath = path.resolve('flows', 'example.json');
      const rawFlow = fs.readFileSync(flowPath);
      const flow = JSON.parse(rawFlow);

      const botResponse = processMessage(msgBody.toLowerCase(), flow);

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
          url: '/messages/send',
          payload: {
            to: from,
            type: 'text',
            content: { body: botResponse },
          },
        });
      } catch (err) {
        fastify.log.error('Erro ao enviar resposta do bot:', err);
      }
    }

    reply.code(200).send('EVENT_RECEIVED');
  });
}