// services/realtime/emitToRoom.js
import axios from 'axios';

// prioriza REALTIME_EMIT_URL; se vazio, tenta SOCKET_URL
const BASE = (process.env.REALTIME_EMIT_URL || process.env.SOCKET_URL || '').replace(/\/$/, '');

/**
 * Emite para um room via HTTP /emit.
 * Aceita `room` e `event` explícitos; se vierem ausentes, tenta inferir:
 *  - room  <- payload.user_id
 *  - event <- 'update_message' se existir 'status' em payload, senão 'new_message'
 */
export async function emitToRoom({ room, event, payload } = {}) {
  if (!BASE) {
    console.warn('[emitToRoom] BASE não definida (REALTIME_EMIT_URL/SOCKET_URL)');
    return;
  }

  if (!room)   room  = payload?.user_id;
  if (!event)  event = payload?.status ? 'update_message' : 'new_message';

  if (!room || !event) {
    console.warn('[emitToRoom] faltando:', { room, event });
    return;
  }

  try {
    await axios.post(`${BASE}/emit`, { room, event, payload }, { timeout: 7000 });
    // console.log('[emitToRoom] OK ->', { room, event });
  } catch (e) {
    console.warn('[emitToRoom] falhou:', e?.response?.status, e?.message);
  }
}

// açúcares
export const emitNewMessage    = (msg) => emitToRoom({ payload: { ...msg }, event: 'new_message' });
export const emitUpdateMessage = (msg) => emitToRoom({ payload: { ...msg }, event: 'update_message' });
