// services/realtime/socketClient.js
import { io as ioc } from 'socket.io-client';

let ioRef = null;
let queue = [];
let connected = false;

export function getIO() {
  if (ioRef) return ioRef;

  const url = process.env.SOCKET_URL;               // ex: https://channels.seu-dominio.com
  const path = process.env.SOCKET_PATH || '/socket.io';
  const namespace = process.env.SOCKET_NAMESPACE || '/';
  const authToken = process.env.SOCKET_TOKEN;       // opcional

  if (!url) {
    console.warn('[socket] SOCKET_URL não definido — desabilitado.');
    return { emit: () => {}, on: () => {}, connected: () => false };
  }

  const base = ioc(`${url}${namespace}`, {
    path,
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 10000,
    auth: authToken ? { token: authToken } : undefined,
    extraHeaders: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
  });

  base.on('connect', () => {
    connected = true;
    console.log('[socket] conectado', base.id);
    // drena fila
    for (const { ev, payload } of queue) {
      try { base.emit(ev, payload); } catch {}
    }
    queue = [];
  });

  base.on('disconnect', (r) => {
    connected = false;
    console.warn('[socket] disconnect:', r);
  });

  base.on('connect_error', (e) => {
    connected = false;
    console.warn('[socket] connect_error:', e?.message || e);
  });

  ioRef = {
    emit(ev, payload) {
      if (connected) {
        try { base.emit(ev, payload); } catch (e) { console.warn('[socket emit]', e?.message || e); }
      } else {
        if (queue.length < 500) queue.push({ ev, payload });
      }
    },
    on: (...args) => base.on(...args),
    connected: () => connected
  };

  return ioRef;
}
