import { supabase } from '../services/db.js';

export default async function flowRoutes(fastify, opts) {
  fastify.post('/publish', async (req, reply) => {
    const { data } = req.body;

    if (!data || typeof data !== 'object') {
      return reply.code(400).send({ error: 'Fluxo inválido ou ausente.' });
    }

    const res = await supabase.from('flows').insert([
      { data, created_at: new Date().toISOString() }
    ]);

    if (res.error) {
      reply.code(500).send({ error: 'Erro ao salvar fluxo', detail: res.error });
    } else {
      reply.send({ message: 'Fluxo publicado com sucesso.' });
    }
  });
}
