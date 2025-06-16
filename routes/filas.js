import { dbPool } from '../services/db.js';

async function quickReplyRoutes(fastify, options) {
  // ➕ Criar nova resposta rápida
  fastify.post('/', async (req, reply) => {
    const { title, content } = req.body;
    if (!title || !content) {
      return reply.code(400).send({ error: 'title e content são obrigatórios' });
    }

    try {
      const { rows } = await dbPool.query(
        'INSERT INTO quick_replies (title, content) VALUES ($1, $2) RETURNING *',
        [title, content]
      );
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao criar resposta rápida' });
    }
  });

  // 📄 Listar todas as respostas rápidas
  fastify.get('/', async (_, reply) => {
    try {
      const { rows } = await dbPool.query(
        'SELECT id, title, content FROM quick_replies ORDER BY title'
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao buscar respostas rápidas' });
    }
  });

  // 🗑️ Remover uma resposta rápida
  fastify.delete('/:id', async (req, reply) => {
    const { id } = req.params;
    try {
      const { rowCount } = await dbPool.query('DELETE FROM quick_replies WHERE id = $1', [id]);
      if (rowCount === 0) return reply.code(404).send({ error: 'Resposta não encontrada' });
      return reply.send({ success: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao deletar resposta' });
    }
  });

  // 🔄 Definir ou atualizar permissão para transferência de fila
  fastify.post('/fila-permissoes', async (req, reply) => {
    const { usuario_email, fila_id, pode_transferir } = req.body;
    if (!usuario_email || !fila_id) {
      return reply
        .code(400)
        .send({ error: 'usuario_email e fila_id são obrigatórios' });
    }

    try {
      const { rows } = await dbPool.query(
        `
        INSERT INTO fila_permissoes (usuario_email, fila_id, pode_transferir)
        VALUES ($1, $2, $3)
        ON CONFLICT (usuario_email, fila_id)
        DO UPDATE SET pode_transferir = EXCLUDED.pode_transferir
        RETURNING *
        `,
        [usuario_email, fila_id, pode_transferir ?? false]
      );
      return reply.send(rows[0]);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao definir permissão' });
    }
  });

  // 👀 Obter permissões de fila para um usuário
  fastify.get('/fila-permissoes/:email', async (req, reply) => {
    const { email } = req.params;
    try {
      const { rows } = await dbPool.query(
        `
        SELECT f.id, f.nome, p.pode_transferir
        FROM fila_permissoes p
        JOIN filas f ON p.fila_id = f.id
        WHERE p.usuario_email = $1 AND p.pode_transferir = true
        ORDER BY f.nome
        `,
        [email]
      );
      return reply.send(rows);
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Erro ao buscar permissões' });
    }
  };
}

export default quickReplyRoutes;
