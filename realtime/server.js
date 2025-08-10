// sse.js  (rodar com: node sse.js)
// Servidor SSE + LISTEN/NOTIFY com PG local

import Fastify from 'fastify';
import pg from 'pg';

const {
  SSE_PORT = 8090,
  PGHOST = process.env.PGHOST || 'localhost',
  PGPORT = process.env.PGPORT || 5432,
  PGUSER = process.env.PGUSER || 'postgres',
  PGPASSWORD = process.env.PGPASSWORD || 'postgres',
  PGDATABASE = process.env.PGDATABASE || 'postgres',
} = process.env;

const app = Fastify({ logger: true });
const { Client } = pg;

// 1 conexão dedicada para LISTEN (não use pool)
const pgListen = new Client({
  host: PGHOST,
  port: Number(PGPORT),
  user: PGUSER,
  password: PGPASSWORD,
  database: PGDATABASE,
});

const subs = new Map(); // user_id -> Set(res)

function push(userId, event, payload) {
  const set = subs.get(String(userId));
  if (!set || !set.size) return;
  const data = JSON.stringify(payload);
  for (const res of set) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${data}\n\n`);
  }
}

app.get('/events', (req, reply) => {
  const userId = String(req.query.user_id || '');
  if (!userId) return reply.code(400).send({ error: 'user_id obrigatório' });

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  reply.hijack();

  if (!subs.has(userId)) subs.set(userId, new Set());
  const res = reply.raw;
  subs.get(userId).add(res);

  const ping = setInterval(() => res.write(`: ping\n\n`), 25000);

  req.raw.on('close', () => {
    clearInterval(ping);
    const set = subs.get(userId);
    if (!set) return;
    set.delete(res);
    if (!set.size) subs.delete(userId);
  });

  // opcional: hello
  res.write(`event: ready\n`);
  res.write(`data: {"ok":true}\n\n`);
});

async function start() {
  await pgListen.connect();
  app.log.info('🗄️ PG LISTEN conectado');

  // canais que vamos ouvir
  await pgListen.query('LISTEN new_message');
  await pgListen.query('LISTEN update_message');
  await pgListen.query('LISTEN bot_processing');

  pgListen.on('notification', (msg) => {
    try {
      const payload = JSON.parse(msg.payload || '{}');
      const uid = payload.user_id || payload.userId || payload.uid;
      if (!uid) return;
      push(uid, msg.channel, payload);
      app.log.debug({ channel: msg.channel, uid }, 'SSE broadcast');
    } catch (e) {
      app.log.warn('NOTIFY payload inválido:', e.message);
    }
  });

  pgListen.on('error', (e) => app.log.error('pg error:', e));

  await app.listen({ host: '0.0.0.0', port: Number(SSE_PORT) });
  app.log.info(`🔊 SSE @ :${SSE_PORT}/events?user_id=...`);
}

start().catch((e) => { console.error(e); process.exit(1); });
