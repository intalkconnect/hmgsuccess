import { dbPool } from '../services/db.js';

async function ticketsRoutes(fastify, options) {
  // Validação simples do formato do user_id
  function isValidUserId(user_id) {
    return /^[\w\d]+@[\w\d.-]+$/.test(user_id);
  }

  // GET /tickets/:user_id → Consulta ticket
  fastify.get('/:user_id', async (req, reply) => {
    const { user_id } = req.params;

    if (!isValidUserId(user_id)) {
      return reply.code(400).send({
        error: 'Formato de user_id inválido. Use: usuario@dominio',
      });
    }

    try {
      const { rows } = await dbPool.query(
        `SELECT status, fila, assigned_to
         FROM tickets
         WHERE user_id = $1 AND status = 'open'`,
        [user_id]
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Ticket não encontrado' });
      }

      return reply.send(rows[0]);
    } catch (error) {
      fastify.log.error('Erro ao buscar ticket:', error);
      return reply.code(500).send({
        error: 'Erro interno ao buscar ticket',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

  // PUT /tickets/:user_id → Atualiza status, fila ou assigned_to
  fastify.put('/:user_id', async (req, reply) => {
    const { user_id } = req.params;
    const { status, fila, assigned_to } = req.body;

    if (!isValidUserId(user_id)) {
      return reply.code(400).send({
        error: 'Formato de user_id inválido. Use: usuario@dominio',
      });
    }

    if (!status && !fila && !assigned_to) {
      return reply.code(400).send({
        error: 'Informe ao menos um campo: status, fila ou assigned_to',
      });
    }

    const updates = [];
    const values = [];
    let index = 1;

    if (status) {
      updates.push(`status = $${index++}`);
      values.push(status);
    }
    if (fila) {
      updates.push(`fila = $${index++}`);
      values.push(fila);
    }
    if (assigned_to) {
      updates.push(`assigned_to = $${index++}`);
      values.push(assigned_to);
    }

    values.push(user_id); // Para o WHERE

    try {
      const { rowCount } = await dbPool.query(
        `UPDATE tickets
         SET ${updates.join(', ')}, updated_at = NOW()
         WHERE user_id = $${index}`,
        values
      );

      if (rowCount === 0) {
        return reply.code(404).send({ error: 'Ticket não encontrado para atualizar' });
      }

      return reply.send({ success: true });
    } catch (error) {
      fastify.log.error('Erro ao atualizar ticket:', error);
      return reply.code(500).send({
        error: 'Erro interno ao atualizar ticket',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });
}

export default ticketsRoutes;
