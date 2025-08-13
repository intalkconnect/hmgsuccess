// services/db.js
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// ⚙️ Schema padrão (fixe "hmg" aqui ou use PG_SCHEMA=hmg no .env)
const PG_SCHEMA = process.env.PG_SCHEMA || 'hmg';

// Escapa identificadores para uso no SET search_path
function ident(s) {
  return /^[a-z0-9_]+$/.test(String(s)) ? s : `"${String(s).replace(/"/g, '""')}"`;
}

export let dbPool = null;

export const initDB = async () => {
  if (dbPool) return dbPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('A variável de ambiente DATABASE_URL deve estar definida');
  }

  dbPool = new Pool({
    connectionString,
    // Supabase normalmente exige SSL (cert self-signed)
    ssl: connectionString.includes('supabase') ? { rejectUnauthorized: false } : false,
    max: Number(process.env.PG_MAX || 20),
    idleTimeoutMillis: Number(process.env.PG_IDLE || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT || 2000),
  });

  // Toda conexão recém-criada entra com search_path = <PG_SCHEMA>,public
  dbPool.on('connect', (client) => {
    client
      .query(`SET search_path TO ${ident(PG_SCHEMA)}, public`)
      .catch((e) => console.error('[db] SET search_path falhou:', e?.message));
  });

  // Validação simples de conectividade + log do search_path efetivo
  try {
    const client = await dbPool.connect();
    try {
      const res = await client.query('SHOW search_path');
      console.log('[db] Conectado. search_path =', res.rows?.[0]?.search_path);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Erro ao conectar no PostgreSQL dentro de initDB():', error);
    throw error;
  }

  return dbPool;
};
