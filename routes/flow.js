import { pool } from '../services/db.js'

export default async function flowRoutes(fastify, opts) {

  // Cria e atualiza um fluxo
  fastify.post('/publish', async (req, reply) => {
    const { data } = req.body

    if (!data || typeof data !== 'object') {
      return reply.code(400).send({ error: 'Fluxo inválido ou ausente.' })
    }

    try {
      // 1) Insere fluxo vazio
      const insertRes = await pool.query(
        'INSERT INTO flows (data, created_at) VALUES ($1, $2) RETURNING id',
        [{}, new Date().toISOString()]
      )

      const insertedId = insertRes.rows[0].id
      const updatedFlow = { ...data, id: insertedId }

      // 2) Atualiza com o JSON final (com o ID embutido)
      await pool.query(
        'UPDATE flows SET data = $1 WHERE id = $2',
        [updatedFlow, insertedId]
      )

      reply.send({ message: 'Fluxo publicado com sucesso.', id: insertedId })
    } catch (err) {
      reply.code(500).send({ error: 'Erro ao salvar fluxo', detail: err.message })
    }
  })

  // Recupera sessão por user_id
  fastify.get('/sessions/:user_id', async (req, reply) => {
    const { user_id } = req.params

    try {
      const { rows } = await pool.query(
        'SELECT * FROM sessions WHERE user_id = $1 LIMIT 1',
        [user_id]
      )

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Sessão não encontrada' })
      }

      reply.send(rows[0])
    } catch (err) {
      reply.code(500).send({ error: 'Erro ao buscar sessão', detail: err.message })
    }
  })

  // Cria ou atualiza sessão
  fastify.post('/sessions/:user_id', async (req, reply) => {
    const { user_id } = req.params
    const { current_block, flow_id, vars } = req.body

    try {
      await pool.query(
        `INSERT INTO sessions (user_id, current_block, last_flow_id, vars, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE
         SET current_block = $2,
             last_flow_id = $3,
             vars = $4,
             updated_at = $5`,
        [user_id, current_block, flow_id, vars, new Date().toISOString()]
      )

      reply.send({ message: 'Sessão salva com sucesso.' })
    } catch (err) {
      reply.code(500).send({ error: 'Erro ao salvar sessão', detail: err.message })
    }
  })

  // Ativa um fluxo
  fastify.post('/activate', async (req, reply) => {
    const { id } = req.body

    try {
      await pool.query(
        'UPDATE flows SET active = TRUE WHERE id = $1',
        [id]
      )

      reply.code(200).send({ success: true })
    } catch (err) {
      reply.code(500).send({ error: 'Erro ao ativar fluxo', detail: err.message })
    }
  })

  // Lista os 10 últimos fluxos
  fastify.get('/latest', async (req, reply) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, active, created_at
         FROM flows
         ORDER BY created_at DESC
         LIMIT 10`
      )

      reply.code(200).send(rows)
    } catch (err) {
      reply.code(500).send({ error: 'Falha ao buscar últimos fluxos', detail: err.message })
    }
  })

  // Retorna somente o campo data de um fluxo
  fastify.get('/data/:id', async (req, reply) => {
    const { id } = req.params

    try {
      const { rows } = await pool.query(
        'SELECT data FROM flows WHERE id = $1 LIMIT 1',
        [id]
      )

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Fluxo não encontrado' })
      }

      reply.code(200).send(rows[0].data)
    } catch (err) {
      reply.code(500).send({ error: 'Erro ao buscar fluxo', detail: err.message })
    }
  })
}
