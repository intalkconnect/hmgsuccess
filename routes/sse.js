import { pgBus } from '../services/realtime/pgBus.js';
import crypto from 'crypto';

// Helper: traduz room arbitrária -> nome seguro de canal no PG
function toChannel(room) {
  const r = String(room || '').trim();
  if (r === 'broadcast') return 'broadcast';
  // hash estável para evitar vazamento de dados e colisões
  return 'r_' + crypto.createHash('sha1').update(r).digest('hex');
}

export default async function sseRoutes(fastify) {
  fastify.get('/sse', async (req, reply) => {
    const rooms = []
      .concat(req.query.room ?? [])
      .map(String)
      .filter(Boolean);

    const listenRooms = rooms.length ? rooms : ['broadcast'];

    // headers SSE
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    const send = (event, data) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const hb = setInterval(() => reply.raw.write(': ping\n\n'), 15000);

    await pgBus.ready();

    const offFns = [];
    for (const room of listenRooms) {
      const channel = toChannel(room); // <- aqui sanitiza para o PG
      await pgBus.listen(channel);
      const handler = (msg) => {
        const ev  = msg?.event || 'message';
        const out = msg?.data ?? msg;
        // mantém `room` original no payload para o cliente
        send(ev, { room, ...out });
      };
      pgBus.on(channel, handler);
      offFns.push(async () => {
        pgBus.off(channel, handler);
        await pgBus.unlisten(channel);
      });
    }

    send('ready', {
      rooms: listenRooms,
      channels: listenRooms.map(toChannel), // útil para debug
    });

    req.raw.on('close', async () => {
      clearInterval(hb);
      for (const off of offFns) {
        try { await off(); } catch {}
      }
    });
  });
}
