// services/realtime/emitToRoom.js
import axios from 'axios';

// prioriza REALTIME_EMIT_URL; se vazio, tenta SOCKET_URL
const BASE = (process.env.REALTIME_EMIT_URL || process.env.SOCKET_URL || '').replace(/\/$/, '');

/**
 * Emite para um room via HTTP /emit.
 * @param {{ room?: string, event?: string, payload?: any }} param0
 *  - se room ou event faltarem, essa função aborta silenciosamente (log warn)
 */
export async function emitToRoom({ room, event, payload } = {}) {
  if (!BASE) {
    console.warn('[emitToRoom] BASE não definida (REALTIME_EMIT_URL/SOCKET_URL)');
    return;
  }
  if (!room || !event) {
    console.warn('[emitToRoom] faltando room/event', { room, event });
    return;
  }
  try {
    await axios.post(`${BASE}/emit`, { room, event, payload }, { timeout: 7000 });
  } catch (e) {
    console.warn('[emitToRoom] falhou:', e?.response?.status, e?.message);
  }
}

// Helpers focados na fila
export async function emitQueuePush(fila, extra = {}) {
  return emitToRoom({
    room: `queue:${fila}`,
    event: 'queue_push',
    payload: { fila, ...extra },
  });
}

export async function emitQueuePop(fila, extra = {}) {
  return emitToRoom({
    room: `queue:${fila}`,
    event: 'queue_pop',
    payload: { fila, ...extra },
  });
}

export async function emitQueueCount(fila, count) {
  return emitToRoom({
    room: `queue:${fila}`,
    event: 'queue_count',
    payload: { fila, count },
  });
}
