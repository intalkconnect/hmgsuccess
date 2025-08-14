// services/realtime/emitter.js
import axios from 'axios';

const BASE = (process.env.REALTIME_EMIT_URL || '').replace(/\/$/, '');

export async function emitRealtime({ room, event, payload }) {
  if (!room) throw new Error('room é obrigatório');
  if (!event) throw new Error('event é obrigatório');

  if (!BASE) {
    console.warn('[emitRealtime] REALTIME_EMIT_URL não definido — emit ignorado');
    return;
  }

  try {
    await axios.post(`${BASE}/emit`, { room, event, payload }, { timeout: 5000 });
    // opcional: log de debug
    // console.log('[emitRealtime] ->', { room, event, ok: true });
  } catch (e) {
    console.warn('[emitRealtime] falhou:', e?.response?.status, e?.message);
  }
}
