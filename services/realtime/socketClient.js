// services/realtime/socketClient.js
import { io as ioc } from 'socket.io-client';

let ioRef = null;

export function getIO() {
  if (ioRef) return ioRef;

  const url        = process.env.SOCKET_URL;        // ex.: http://realtime:8080
  const path       = process.env.SOCKET_PATH || '/socket.io';
  const namespace  = process.env.SOCKET_NAMESPACE || '/';
  const authToken  = process.env.SOCKET_TOKEN;      // mesmo do servidor

  if (!url) {
    console.warn('[socket] SOCKET_URL não definido — desabilitado.');
    return { emit: () => {}, on: () => {}, connected: () => false };
  }

  const base = ioc(`${url}${namespace}`, {
    path,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 10000,
    auth: authToken ? { token: authToken } : undefined,
    extraHeaders: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
  });

  base.on('connect', () => {
    console.log('[socket] conectado (worker)', base.id);
  });
  base.on('disconnect', (r) => console.warn('[socket] disconnect:', r));
  base.on('connect_error', (e) => console.warn('[socket] connect_error:', e?.message || e));

  ioRef = {
    emit: (...args) => base.emit(...args),
    on: (...args) => base.on(...args),
    connected: () => base.connected,
  };
  return ioRef;
}
