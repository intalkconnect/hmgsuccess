// services/realtime/emitToRoom.js
import { dbPool } from '../db.js';
import { toChannel } from '../../utils/channel.js';

export async function emitToRoom(_io, { room, event, data }) {
  if (!room) return;
  const payload = JSON.stringify({ event: String(event || 'message'), data });
  await dbPool.query(`SELECT pg_notify($1, $2)`, [toChannel(room), payload]);
}

export async function broadcast(event, data) {
  const payload = JSON.stringify({ event: String(event || 'message'), data });
  await dbPool.query(`SELECT pg_notify('broadcast', $1)`, [payload]);
}
