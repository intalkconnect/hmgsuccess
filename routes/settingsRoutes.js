// src/routes/settingsRoutes.js
import { pool } from '../services/db.js';

export default async function settingsRoutes(fastify, opts) {
  fastify.get('/distribuicao_tickets', async (req, reply) => {
    try {
      const result = await pool.query(
        `SELECT value FROM settings WHERE key = 'distribuicao_tickets' LIMIT 1`
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Configuração não encontrada' });
      }

      return reply.code(200).send({ value: result.rows[0].value });
    } catch (err) {
      req.log.error('Erro ao buscar configuração:', err);
      return reply.code(500).send({ error: 'Erro interno ao acessar configurações' });
    }
  });
}
