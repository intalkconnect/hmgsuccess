// realtime/server.js  (SSE + LISTEN/NOTIFY, sem WebSocket)
import Fastify from 'fastify';
import pg from 'pg';

// PG (usa DATABASE_URL se existir; senão, variáveis PG*)
const {
  PORT = Number(process.env.SOCKET_PORT || 8080),
  PGHOST = process.env.PGHOST || 'localhost',
  PGPORT = process.env.PGPORT || 5432,
  PGUSER = process.env.PGUSER || 'postgres',
  PGPASSWORD = process.env.PGPASSWORD || 'postgres',
  PGDATABASE = process.env.PGDATABASE || 'postgres',
} = process.env;

const app = Fastify({ logger: true });

// ---------- LISTEN/NOTIFY ----------
const { Client } = pg;
const pgListen = new Client(
  DATABASE_URL
    ? { connectionString: DATABASE_URL }
    : { host: PGHOST, port: Number(PGPORT), user: PGUSER, password: PGPASSWORD, database: PGDATABASE }
);

// subscribers: user_id -> Set(res)
const subscribers = new Map();

function ssePush(userId, event, payload) {
  const set = subscribers.get(String(userId));
  if (!set || !set.size) return;
  const data = JSON.stringify(payload);
  for (const res of set) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${data}\n\n`);
  }
}

// ---------- SSE endpoint ----------
app.get('/events', (req, reply) => {
  const userId = String(req.query.user_id || '');
  if (!userId) return reply.code(400).send({ error: 'user_id obrigatório' });

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  reply.hijack();
  const res = reply.raw;

  if (!subscribers.has(userId)) subscribers.set(userId, new Set());
  subscribers.get(userId).add(res);

  const ping = setInterval(() => res.write(`: ping\n\n`), 25000);

  req.raw.on('close', () => {
    clearInterval(ping);
    const set = subscribers.get(userId);
    if (!set) return;
    set.delete(res);
    if (!set.size) subscribers.delete(userId);
  });

  res.write(`event: ready\n`);
  res.write(`data: {"ok":true}\n\n`);
});

// health
app.get('/healthz', async () => ({ ok: true, subs: [...subscribers.keys()].length }));

async function startPgListen() {
  await pgListen.connect();
  app.log.info('🗄️ PG LISTEN conectado');

  await pgListen.query('LISTEN new_message');
  await pgListen.query('LISTEN update_message');
  await pgListen.query('LISTEN bot_processing');

  pgListen.on('notification', (msg) => {
    try {
      const payload = JSON.parse(msg.payload || '{}');
      const uid = payload.user_id || payload.userId || payload.uid;
      if (!uid) return;
      ssePush(uid, msg.channel, payload);
      app.log.debug({ channel: msg.channel, user_id: uid }, 'SSE broadcast');
    } catch (e) {
      app.log.warn('NOTIFY payload inválido:', e?.message || e);
    }
  });

  pgListen.on('error', (e) => app.log.error('pg listen error:', e));
}

app.listen({ host: '0.0.0.0', port: PORT })
  .then(async () => {
    app.log.info(`🔊 SSE @ :${PORT}/events?user_id=...`);
    await startPgListen();
  })
  .catch((e) => { app.log.error(e); process.exit(1); });

// (export vazio só pra não quebrar imports antigos — ninguém usa mais)
export const io = null;
