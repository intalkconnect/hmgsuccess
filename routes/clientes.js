// backend/routes/clientes.js
export default async function clientesRoutes(fastify) {
  // GET /clientes/:user_id → retorna dados do cliente
  fastify.get('/:user_id', async (req, reply) => {
    const { user_id } = req.params;

    try {
      const { rows } = await fastify.pg.query(
        'SELECT name, phone FROM clientes WHERE user_id = $1 LIMIT 1',
        [user_id]
      );

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Cliente não encontrado' });
      }

      return rows[0];
    } catch (err) {
      console.error('Erro ao buscar cliente:', err);
      return reply.status(500).send({ error: 'Erro interno ao buscar cliente' });
    }
  });
}
