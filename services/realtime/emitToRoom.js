// services/realtime/emitToRoom.js
import { dbPool } from '../db.js';

export async function emitToRoom(_ioNotUsed, { room, event, data }) {
  if (!room) return;
  // payload tem limite de ~8KB no Postgres; mantenha conciso
  const payload = JSON.stringify({ event: String(event || 'message'), data });
  // canal precisa ser identificado; usamos aspas para evitar problemas com hífens
  await dbPool.query(`SELECT pg_notify($1, $2)`, [String(room), payload]);
}

// atalho para broadcast opcional
export async function broadcast(event, data) {
  const payload = JSON.stringify({ event: String(event || 'message'), data });
  await dbPool.query(`SELECT pg_notify('broadcast', $1)`, [payload]);
}
