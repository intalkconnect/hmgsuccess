import { dbPool } from '../services/db.js';

async function settingsRoutes(fastify, options) {
  // Rota GET /settings - Busca uma configuração específica
  // Rota GET /settings - Retorna todas as configurações
fastify.get('/', async (req, reply) => {
  try {
    const { rows } = await dbPool.query(
      `SELECT 
         key,
         value,
       FROM settings`
    );

    return reply.send(rows);
  } catch (error) {
    fastify.log.error('Erro ao buscar configurações:', error);
    return reply.code(500).send({ 
      error: 'Erro interno ao buscar configurações',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


  // Rota POST /settings - Cria/atualiza uma configuração
  fastify.post('/', async (req, reply) => {
    const { key, value } = req.body;

    // Validação dos dados
    if (!key || value === undefined) {
      return reply.code(400).send({ 
        error: 'Campos key e value são obrigatórios' 
      });
    }

    try {
      const { rows } = await dbPool.query(
        `INSERT INTO settings (key, value, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) 
         DO UPDATE SET 
           value = EXCLUDED.value,
           updated_at = NOW()
         RETURNING *`,
        [key, value]
      );

      return reply.code(201).send(rows[0]);
    } catch (error) {
      fastify.log.error('Erro ao salvar configuração:', error);
      return reply.code(500).send({ 
        error: 'Erro interno ao salvar configuração',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });
}

export default settingsRoutes;
