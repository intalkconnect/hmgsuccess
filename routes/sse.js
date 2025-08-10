// routes/sse.js
import pg from 'pg';

export default async function sseRoutes(fastify) {
  // GET /sse?room=chat-<userId> (pode ouvir múltiplos via &room=a&room=b)
  fastify.get('/sse', async (req, reply) => {
    const rooms = []
      .concat(req.query.room ?? [])
      .map(String)
      .filter(Boolean);

    // headers SSE
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // evita buffering em proxies Nginx
      'Access-Control-Allow-Origin': '*',
    });

    // helper para enviar evento SSE
    const send = (event, data) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // heartbeat p/ manter vivo (e detectar disconnect em proxies)
    const hb = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

    // conexão dedicada para LISTEN (não use o Pool, use Client)
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    // liga nos canais solicitados
    for (const room of rooms) {
      await client.query(`LISTEN "${room}"`);
    }
    // opcional: um canal "broadcast" genérico
    await client.query(`LISTEN "broadcast"`);

    // handler de notificações -> repassa via SSE
    client.on('notification', (msg) => {
      try {
        // msg.channel (string) / msg.payload (string)
        const payload = msg.payload ? JSON.parse(msg.payload) : {};
        // você pode padronizar com event:data ou só mandar tudo no "message"
        send(payload.event || 'message', { room: msg.channel, ...payload });
      } catch {
        send('message', { room: msg.channel, payload: msg.payload });
      }
    });

    // fecha tudo no disconnect
    req.raw.on('close', async () => {
      clearInterval(hb);
      try { await client.end(); } catch {}
    });

    // dá um “olá” inicial
    send('ready', { rooms });
  });
}
