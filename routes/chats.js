
// routes/chatsRoutes.js
import { dbPool } from '../services/db.js';

async function chatsRoutes(fastify, options) {
  fastify.get('/', async (req, reply) => {
    const { assigned_to, filas } = req.query;

    if (!assigned_to || !filas) {
      return reply.code(400).send({
        error: 'Parâmetros obrigatórios: assigned_to (email) e filas (CSV)',
      });
    }

    const filaList = filas.split(',').map((f) => f.trim());

    try {
      const { rows } = await dbPool.query(
        `
        SELECT 
          t.user_id,
          t.ticket_number,
          t.fila,
          t.assigned_to,
          t.status,
          c.name,
          c.channel,
          c.phone,
          c.atendido
        FROM tickets t
        JOIN clientes c ON t.user_id = c.user_id
        WHERE t.status = 'open'
          AND t.assigned_to = $1
          AND t.fila = ANY($2)
        ORDER BY t.created_at DESC
        `,
        [assigned_to, filaList]
      );

      return reply.send(rows);
    } catch (error) {
      fastify.log.error('Erro ao buscar chats:', error);
      return reply.code(500).send({
        error: 'Erro interno ao buscar chats',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  });

  fastify.get('/fila', async (req, reply) => {
  const { filas } = req.query;

  if (!filas) {
    return reply.code(400).send({
      error: 'Parâmetro obrigatório: filas (CSV)',
    });
  }

  const filaList = filas.split(',').map((f) => f.trim());

  try {
    const { rows } = await dbPool.query(
      `
      SELECT 
        t.id,
        t.user_id,
        t.ticket_number,
        t.fila,
        t.status,
        t.created_at
      FROM tickets t
      WHERE t.status = 'open'
        AND (t.assigned_to IS NULL OR t.assigned_to = '')
        AND t.fila = ANY($1)
      ORDER BY t.created_at ASC
      `,
      [filaList]
    );

    return reply.send(rows);
  } catch (error) {
    fastify.log.error('Erro ao buscar fila:', error);
    return reply.code(500).send({
      error: 'Erro interno ao buscar fila',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

}

export default chatsRoutes;
