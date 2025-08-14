import axios from 'axios';

// usa REALTIME_EMIT_URL (ou SOCKET_URL) e tira barra do fim
const BASE = (process.env.REALTIME_EMIT_URL || process.env.SOCKET_URL || '').replace(/\/$/, '');

export async function emitToRoom({ room, event, payload }) {
  if (!BASE) { console.warn('[emitToRoom] REALTIME_EMIT_URL/SOCKET_URL não definido'); return; }
  if (!room || !event) { console.warn('[emitToRoom] room/event faltando'); return; }
  try {
    await axios.post(`${BASE}/emit`, { room, event, payload }, { timeout: 7000 });
  } catch (e) {
    console.warn('[emitToRoom] falhou:', e?.response?.status, e?.message);
  }
}

export const emitNewMessage    = (msg) => emitToRoom({ room: msg.user_id, event: 'new_message',    payload: msg });
export const emitUpdateMessage = (msg) => emitToRoom({ room: msg.user_id, event: 'update_message', payload: msg });
