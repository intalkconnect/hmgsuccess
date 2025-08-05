import { dbPool } from '../services/db.js';

export default async function flowRoutes(fastify, opts) {
  fastify.post('/publish', async (req, reply) => {
    const { data } = req.body;

    if (!data || typeof data !== 'object') {
      return reply.code(400).send({ error: 'Fluxo inválido ou ausente.' });
    }

    try {
      // Inserir novo fluxo vazio
      const insertRes = await dbPool.query(
        'INSERT INTO flows(data, created_at) VALUES($1, $2) RETURNING id',
        [{}, new Date().toISOString()]
      );

      const insertedId = insertRes.rows[0].id;
      const updatedFlow = { ...data, id: insertedId };

      // Atualiza o fluxo com os dados completos
      await dbPool.query(
        'UPDATE flows SET data = $1 WHERE id = $2',
        [updatedFlow, insertedId]
      );

      reply.send({ message: 'Fluxo publicado com sucesso.', id: insertedId });
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: 'Erro ao salvar fluxo', detail: error.message });
    }
  });

  fastify.get('/sessions/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    
    try {
      const { rows } = await dbPool.query(
        'SELECT * FROM sessions WHERE user_id = $1 LIMIT 1',
        [user_id]
      );

      if (rows.length === 0) {
        reply.code(404).send({ error: 'Sessão não encontrada' });
      } else {
        reply.send(rows[0]);
      }
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: 'Erro ao buscar sessão', detail: error.message });
    }
  });

  fastify.post('/sessions/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    const { current_block, flow_id, vars } = req.body;

    try {
      await dbPool.query(`
        INSERT INTO sessions(user_id, current_block, last_flow_id, vars, updated_at)
        VALUES($1, $2, $3, $4, $5)
        ON CONFLICT (user_id) 
        DO UPDATE SET 
          current_block = EXCLUDED.current_block,
          last_flow_id = EXCLUDED.last_flow_id,
          vars = EXCLUDED.vars,
          updated_at = EXCLUDED.updated_at
      `, [user_id, current_block, flow_id, vars, new Date().toISOString()]);

      reply.send({ message: 'Sessão salva com sucesso.' });
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({ error: 'Erro ao salvar sessão', detail: error.message });
    }
  });

  fastify.post('/activate', async (req, reply) => {
    const { id } = req.body;
    
    try {
      await dbPool.query(
        'UPDATE flows SET active = true WHERE id = $1',
        [id]
      );
      return reply.code(200).send({ success: true });
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Erro ao ativar fluxo', detail: error.message });
    }
  });

  fastify.get('/latest', async (req, reply) => {
    try {
      const { rows } = await dbPool.query(`
      SELECT id, active, created_at 
      FROM flows 
      WHERE active = true 
      `);

      return reply.code(200).send(rows);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ 
        error: 'Falha ao buscar últimos fluxos', 
        detail: error.message 
      });
    }
  });

  fastify.get('/history', async (req, reply) => {
  try {
    const { rows } = await dbPool.query(`
      SELECT id, data, active, created_at 
      FROM flows 
      ORDER BY created_at DESC 
      LIMIT 10
    `);

    return reply.code(200).send(rows);
  } catch (error) {
    fastify.log.error(error);
    return reply.code(500).send({ 
      error: 'Erro ao buscar histórico de versões', 
      detail: error.message 
    });
  }
});


  fastify.get('/data/:id', async (req, reply) => {
    const { id } = req.params;

    try {
      const { rows } = await dbPool.query(
        'SELECT data FROM flows WHERE id = $1',
        [id]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Fluxo não encontrado' });
      }

      return reply.code(200).send(rows[0].data);
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ 
        error: 'Erro ao buscar fluxo', 
        detail: error.message 
      });
    }
  });
}
