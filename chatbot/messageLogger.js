import { pool } from '../services/db.js';
import { randomUUID } from 'crypto';

/**
 * Grava mensagem de saída (outgoing).
 */
export async function logOutgoingMessage(userId, type, content, flowId) {
  const outgoing = {
    id: randomUUID(),
    user_id: userId,
    whatsapp_message_id: randomUUID(),
    direction: 'outgoing',
    type,
    content,
    timestamp: new Date().toISOString(),
    flow_id: flowId || null,
    agent_id: null,
    queue_id: null,
    status: 'sent',
    metadata: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    channel: 'whatsapp',
  };

  try {
    const { rows } = await pool.query(
      `INSERT INTO messages (
        id, user_id, whatsapp_message_id, direction, type, content,
        timestamp, flow_id, agent_id, queue_id, status, metadata,
        created_at, updated_at, channel
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15
      ) RETURNING *`,
      [
        outgoing.id,
        outgoing.user_id,
        outgoing.whatsapp_message_id,
        outgoing.direction,
        outgoing.type,
        outgoing.content,
        outgoing.timestamp,
        outgoing.flow_id,
        outgoing.agent_id,
        outgoing.queue_id,
        outgoing.status,
        outgoing.metadata,
        outgoing.created_at,
        outgoing.updated_at,
        outgoing.channel,
      ]
    );

    console.log('✅ Mensagem outgoing gravada:', rows[0]);
    return rows[0];
  } catch (err) {
    console.error('❌ Erro ao gravar outgoing:', err);
    return null;
  }
}

/**
 * Grava um “fallback” quando falha no envio de mídia.
 */
export async function logOutgoingFallback(userId, fallbackText, flowId) {
  try {
    await pool.query(
      `INSERT INTO messages (
        id, user_id, whatsapp_message_id, direction, type, content,
        timestamp, flow_id, agent_id, queue_id, status, metadata,
        created_at, updated_at, channel
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15
      )`,
      [
        randomUUID(),
        userId,
        randomUUID(),
        'outgoing',
        'text',
        fallbackText,
        new Date().toISOString(),
        flowId || null,
        null,
        null,
        'sent',
        JSON.stringify({ fallback: true }),
        new Date().toISOString(),
        new Date().toISOString(),
        'whatsapp',
      ]
    );
    console.log('✅ Fallback gravado');
  } catch (err) {
    console.error('❌ Erro ao gravar fallback:', err);
  }
}
