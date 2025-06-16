import fp from 'fastify-plugin';

export default quickRepliesRoutes(async (fastify, opts) => {
  // GET /api/v1/quick_replies
  fastify.get('/', async (request, reply) => {
    const { rows } = await fastify.pg.query(
      'SELECT id, title, content, created_at, updated_at FROM quick_replies ORDER BY id'
    );
    return rows;
  });

  // GET /api/v1/quick_replies/:id
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params;
    const { rows } = await fastify.pg.query(
      'SELECT id, title, content, created_at, updated_at FROM quick_replies WHERE id = $1',
      [id]
    );
    if (!rows.length) return reply.code(404).send({ error: 'Not found' });
    return rows[0];
  });

  // POST /api/v1/quick_replies
  fastify.post('/', async (request, reply) => {
    const { title, content } = request.body;
    const { rows } = await fastify.pg.query(
      'INSERT INTO quick_replies (title, content) VALUES ($1, $2) RETURNING id, title, content, created_at, updated_at',
      [title, content]
    );
    return reply.code(201).send(rows[0]);
  });

  // PUT /api/v1/quick_replies/:id
  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params;
    const { title, content } = request.body;
    const { rowCount } = await fastify.pg.query(
      'UPDATE quick_replies SET title = $1, content = $2 WHERE id = $3',
      [title, content, id]
    );
    if (rowCount === 0) return reply.code(404).send({ error: 'Not found' });
    return { ok: true };
  });

  // DELETE /api/v1/quick_replies/:id
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params;
    const { rowCount } = await fastify.pg.query(
      'DELETE FROM quick_replies WHERE id = $1',
      [id]
    );
    if (rowCount === 0) return reply.code(404).send({ error: 'Not found' });
    return { ok: true };
  });
});
