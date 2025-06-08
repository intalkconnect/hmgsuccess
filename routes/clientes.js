import { dbPool } from '../services/db.js';

async function clientesRoutes(fastify, options) {
  // Rota GET /clientes/:user_id - Busca dados de um cliente específico
  fastify.get('/:user_id', async (req, reply) => {
    const { user_id } = req.params;

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
          error: 'Cliente não encontrado',
          user_id
        });
      }

      return reply.send(rows[0]);
    } catch (error) {
      fastify.log.error('Erro ao buscar cliente:', error);
      return reply.code(500).send({ 
        error: 'Erro interno ao buscar dados do cliente',
        user_id,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  // Rota PUT /clientes/:user_id - Atualiza completamente um cliente
  fastify.put('/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    const { name, phone } = req.body;

    // Validação dos dados
    if (!name || !phone) {
      return reply.code(400).send({ 
        error: 'Campos name e phone são obrigatórios',
        user_id
      });
    }

    try {
      const { rows } = await dbPool.query(
        `UPDATE clientes SET
           name = $1,
           phone = $2,
           updated_at = NOW()
         WHERE user_id = $3
         RETURNING *`,
        [name, phone, user_id]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ 
          error: 'Cliente não encontrado para atualização',
          user_id
        });
      }

      return reply.send(rows[0]);
    } catch (error) {
      fastify.log.error('Erro ao atualizar cliente:', error);
      return reply.code(500).send({ 
        error: 'Erro interno ao atualizar cliente',
        user_id,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  // Rota PATCH /clientes/:user_id - Atualiza parcialmente um cliente
  fastify.patch('/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    const { name, phone } = req.body;

    // Validação - pelo menos um campo deve ser fornecido
    if (!name && !phone) {
      return reply.code(400).send({ 
        error: 'Pelo menos um campo (name ou phone) deve ser fornecido',
        user_id
      });
    }

    try {
      // Constrói a query dinamicamente baseada nos campos fornecidos
      const setClauses = [];
      const values = [];
      let paramIndex = 1;

      if (name) {
        setClauses.push(`name = $${paramIndex}`);
        values.push(name);
        paramIndex++;
      }

      if (phone) {
        setClauses.push(`phone = $${paramIndex}`);
        values.push(phone);
        paramIndex++;
      }

      values.push(user_id); // user_id sempre será o último parâmetro

      const query = `
        UPDATE clientes SET
          ${setClauses.join(', ')},
          updated_at = NOW()
        WHERE user_id = $${paramIndex}
        RETURNING *
      `;

      const { rows } = await dbPool.query(query, values);

      if (rows.length === 0) {
        return reply.code(404).send({ 
          error: 'Cliente não encontrado para atualização',
          user_id
        });
      }

      return reply.send(rows[0]);
    } catch (error) {
      fastify.log.error('Erro ao atualizar cliente parcialmente:', error);
      return reply.code(500).send({ 
        error: 'Erro interno ao atualizar cliente',
        user_id,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  // Rota DELETE /clientes/:user_id - Remove um cliente
  fastify.delete('/:user_id', async (req, reply) => {
    const { user_id } = req.params;

    try {
      const { rowCount } = await dbPool.query(
        `DELETE FROM clientes 
         WHERE user_id = $1`,
        [user_id]
      );

      if (rowCount === 0) {
        return reply.code(404).send({ 
          error: 'Cliente não encontrado para exclusão',
          user_id
        });
      }

      return reply.code(204).send();
    } catch (error) {
      fastify.log.error('Erro ao excluir cliente:', error);
      return reply.code(500).send({ 
        error: 'Erro interno ao excluir cliente',
        user_id,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });
}

export default clientesRoutes;
