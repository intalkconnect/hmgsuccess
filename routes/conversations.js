// routes/conversations.js
export default async function conversationsRoutes(fastify) {
  const { pool } = fastify;

  // GET /conversations
fastify.get('/:user_id', async (req, reply) => {
    const { user_id } = req.params;

    try {
      const { rows } = await pool.query(
        'SELECT name, phone FROM clientes WHERE user_id = $1 LIMIT 1',
        [user_id]
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Cliente não encontrado' });
      }

      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Erro interno ao buscar cliente' });
    }
  });

  // GET /last-read
  fastify.get('/last-read', async (req, reply) => {
    try {
      const result = await pool.query(`SELECT user_id, last_read FROM user_last_read`);
      return reply.send(result.rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao buscar last_read' });
    }
  });

  // POST /last-read
  fastify.post('/last-read', async (req, reply) => {
    const { user_id, last_read } = req.body;

    if (!user_id || !last_read) {
      return reply.code(400).send({ error: 'user_id e last_read são obrigatórios' });
    }

    try {
      await pool.query(`
        INSERT INTO user_last_read (user_id, last_read)
        VALUES ($1, $2)
        ON CONFLICT (user_id)
        DO UPDATE SET last_read = EXCLUDED.last_read
      `, [user_id, last_read]);

      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao atualizar last_read' });
    }
  });

  // GET /unread-counts
  fastify.get('/unread-counts', async (req, reply) => {
    try {
      const result = await pool.query(`SELECT * FROM contar_mensagens_nao_lidas()`);
      return reply.send(result.rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao contar mensagens não lidas' });
    }
  });
}
