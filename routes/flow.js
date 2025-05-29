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

  fastify.get('/sessions/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('user_id', user_id)
      .single();

    if (error) {
      reply.code(404).send({ error: 'Sessão não encontrada' });
    } else {
      reply.send(data);
    }
  });

  fastify.post('/sessions/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    const { current_block, flow_id, vars } = req.body;

    const { error } = await supabase
      .from('sessions')
      .upsert({
        user_id,
        current_block,
        last_flow_id: flow_id,
        vars,
        updated_at: new Date().toISOString()
      });

    if (error) {
      reply.code(500).send({ error: 'Erro ao salvar sessão', detail: error });
    } else {
      reply.send({ message: 'Sessão salva com sucesso.' });
    }
  });
}
