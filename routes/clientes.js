import { dbPool } from '../services/db.js';

async function clientesRoutes(fastify, options) {
  // Rota GET /clientes - Busca dados de um cliente específico
  fastify.get('/', async (req, reply) => {
    const { user_id } = req.query;

    // Validação do parâmetro
    if (!user_id) {
      return reply.code(400).send({ 
        error: 'Parâmetro user_id é obrigatório' 
      });
    }

    try {
      const { rows } = await dbPool.query(
        `SELECT 
          name, 
          phone,
          user_id,
          created_at,
          updated_at
         FROM clientes 
         WHERE user_id = $1 
         LIMIT 1`,
        [user_id]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ 
          error: 'Cliente não encontrado' 
        });
      }

      return reply.send(rows[0]);
    } catch (error) {
      fastify.log.error('Erro ao buscar cliente:', error);
      return reply.code(500).send({ 
        error: 'Erro interno ao buscar dados do cliente',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  // Rota POST /clientes - Cria/atualiza um cliente
  fastify.post('/', async (req, reply) => {
    const { user_id, name, phone } = req.body;

    // Validação dos dados
    if (!user_id || !name || !phone) {
      return reply.code(400).send({ 
        error: 'Campos user_id, name e phone são obrigatórios' 
      });
    }

    try {
      const { rows } = await dbPool.query(
        `INSERT INTO clientes (user_id, name, phone)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) 
         DO UPDATE SET 
           name = EXCLUDED.name,
           phone = EXCLUDED.phone,
           updated_at = NOW()
         RETURNING *`,
        [user_id, name, phone]
      );

      return reply.code(201).send(rows[0]);
    } catch (error) {
      fastify.log.error('Erro ao salvar cliente:', error);
      return reply.code(500).send({ 
        error: 'Erro interno ao salvar cliente',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });
}

export default clientesRoutes;
