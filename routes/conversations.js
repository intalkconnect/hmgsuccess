// routes/conversations.js
export default async function conversationsRoutes(fastify) {
  const { pool } = fastify;

  fastify.get('/last-read', async (req, reply) => {
    try {
      const result = await pool.query(`SELECT user_id, last_read FROM user_last_read`);
      return reply.send(result.rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao buscar last_read' });
    }
  });


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

fastify.get('/conversations', async (req, reply) => {
  try {
    const result = await pool.query(`
      SELECT
        m.user_id,
        MAX(m.timestamp) as timestamp,
        MAX(m.id) as last_message_id,
        c.name,
        c.fila,
        c.ticket_number,
        c.atendido,
        m.content,
        m.channel
      FROM messages m
      LEFT JOIN clientes c ON m.user_id = c.user_id
      GROUP BY m.user_id, c.name, c.fila, c.ticket_number, c.atendido, m.content, m.channel
      ORDER BY timestamp DESC
    `);
    return reply.send(result.rows);
  } catch (err) {
    fastify.log.error(err);
    return reply.code(500).send({ error: 'Erro ao buscar conversas' });
  }
});
