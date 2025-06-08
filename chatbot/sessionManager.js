import { pool } from '../services/db.js';

/**
 * Carrega a sessão de um usuário.
 */
export async function loadSession(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM sessions WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    return rows[0] || { current_block: null, vars: {} };
  } catch (err) {
    console.error('❌ Erro ao carregar sessão:', err);
    return { current_block: null, vars: {} };
  }
}

/**
 * Salva (ou atualiza) a sessão de um usuário.
 */
export async function saveSession(userId, currentBlock, flowId, vars) {
  try {
    await pool.query(
      `INSERT INTO sessions (user_id, current_block, last_flow_id, vars, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id)
       DO UPDATE SET current_block = EXCLUDED.current_block,
                     last_flow_id = EXCLUDED.last_flow_id,
                     vars = EXCLUDED.vars,
                     updated_at = EXCLUDED.updated_at`,
      [
        userId,
        currentBlock,
        flowId,
        vars,
        new Date().toISOString()
      ]
    );
  } catch (err) {
    console.error('❌ Erro ao salvar sessão:', err);
  }
}
