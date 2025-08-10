// routes/sse.js
import pg from 'pg';

export default async function sseRoutes(fastify) {
  fastify.get('/sse', async (req, reply) => {
    const rooms = []
      .concat(req.query.room ?? [])
      .map(String)
      .filter(Boolean);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    const send = (event, data) => {
      try {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (_) {
        // ignore write after end
      }
    };

    const hb = setInterval(() => {
      try { reply.raw.write(': ping\n\n'); } catch (_) {}
    }, 15000);

    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    for (const room of rooms) {
      await client.query(`LISTEN "${room}"`);
    }
    await client.query(`LISTEN "broadcast"`);

    client.on('notification', (msg) => {
      try {
        const payload = msg.payload ? JSON.parse(msg.payload) : {};
        send(payload.event || 'message', { room: msg.channel, ...payload });
      } catch {
        send('message', { room: msg.channel, payload: msg.payload });
      }
    });

    req.raw.on('close', async () => {
      clearInterval(hb);
      try { await client.end(); } catch {}
    });

    send('ready', { rooms });
  });
}
