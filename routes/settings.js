import { dbPool } from '../services/db.js';

async function settingsRoutes(fastify, options) {
  // Rota GET /settings - Busca uma configuração específica
  fastify.get('/', async (req, reply) => {

    try {
      const { rows } = await dbPool.query(
        `SELECT 
          key,
          value,
          description,
          created_at,
          updated_at
         FROM settings 
         WHERE key = $1 
         LIMIT 1`
      );

      if (rows.length === 0) {
        return reply.code(404).send({ 
          error: 'Configuração não encontrada' 
        });
      }

      return reply.send(rows[0]);
    } catch (error) {
      fastify.log.error('Erro ao buscar configuração:', error);
      return reply.code(500).send({ 
        error: 'Erro interno ao buscar configuração',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  // Rota POST /settings - Cria/atualiza uma configuração
  fastify.post('/', async (req, reply) => {
    const { key, value, description } = req.body;

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
           description = EXCLUDED.description,
           updated_at = NOW()
         RETURNING *`,
        [key, value, description]
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
