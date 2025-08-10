import { pgBus } from '../services/realtime/pgBus.js';

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

    // garante que o bus está conectado
    await pgBus.ready();

    // registra listeners em memória + LISTEN refCount
    const offFns = [];
    for (const room of listenRooms) {
      await pgBus.listen(room);
      const handler = (msg) => {
        // payload pode vir {event, data} ou direto a mensagem
        const ev  = msg?.event || 'message';
        const out = msg?.data ?? msg;
        send(ev, { room, ...out });
      };
      pgBus.on(room, handler);
      offFns.push(async () => {
        pgBus.off(room, handler);
        await pgBus.unlisten(room);
      });
    }

    send('ready', { rooms: listenRooms });

    req.raw.on('close', async () => {
      clearInterval(hb);
      // remove handlers e baixa UNLISTEN conforme refCount
      for (const off of offFns) {
        try { await off(); } catch {}
      }
    });
  });
}
