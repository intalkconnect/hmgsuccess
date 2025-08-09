// services/realtime/emitToRoom.js
export function emitToRoom(io, { room, event, data }) {
  if (!io || !process.env.SOCKET_URL) return; // socket desabilitado
  if (!room || !event) return;
  try {
    io.emit('server_emit', { room: String(room), event: String(event), data });
  } catch (e) {
    console.warn('[emitToRoom] falha ao emitir:', e?.message || e);
  }
}
