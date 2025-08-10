// services/db.js
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
export let dbPool;

export const initDB = async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('A variável de ambiente DATABASE_URL deve estar definida');
  }

  // Permite SSL condicional (útil no Render/Heroku/etc.)
  const useSSL = String(process.env.PGSSL || '').toLowerCase() === 'true';
  dbPool = new Pool({
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: Number(process.env.PG_MAX || 20),
    idleTimeoutMillis: Number(process.env.PG_IDLE || 30000),
    connectionTimeoutMillis: Number(process.env.PG_TIMEOUT || 2000),
  });

  const client = await dbPool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
};
