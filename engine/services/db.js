// services/db.js
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL não definido');
}

// ⛳️ defina PG_SCHEMA=hmg (ou o schema do tenant que este processo atende)
const PG_SCHEMA = (process.env.PG_SCHEMA || 'public').trim();

function pgIdent(id) {
  return /^[a-z0-9_]+$/.test(id) ? id : `"${String(id).replace(/"/g, '""')}"`;
}

export let dbPool;

export async function initDB() {
  if (dbPool) return dbPool;

  dbPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : false,
    max: Number(process.env.PG_MAX || 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });

  // Toda conexão do pool já nasce com o search_path correto
  dbPool.on('connect', (client) => {
    client.query(`SET search_path TO ${pgIdent(PG_SCHEMA)}, public`).catch((e) => {
      console.error('[db] falha ao SET search_path:', e?.message);
    });
  });

  // Sanidade
  const c = await dbPool.connect();
  try {
    await c.query('SELECT 1');
    // reforça o search_path na primeira vez
    await c.query(`SET search_path TO ${pgIdent(PG_SCHEMA)}, public`);
  } finally {
    c.release();
  }

  console.log(`[db] conectado. search_path=${PG_SCHEMA},public`);
  return dbPool;
}

// helpers opcionais (se quiser usar padrão query/tx)
export const query = (text, params) => dbPool.query(text, params);
export async function tx(fn) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    // por segurança, reforça dentro da tx
    await client.query(`SET LOCAL search_path TO ${pgIdent(PG_SCHEMA)}, public`);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}
