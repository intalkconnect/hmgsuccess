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

  dbPool = new Pool({
    connectionString,
    ssl: connectionString.includes('supabase') ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  try {
    const client = await dbPool.connect();
    await client.query('SELECT 1');
    client.release();
  } catch (error) {
    console.error('Erro ao conectar no PostgreSQL dentro de initDB():', error);
    throw error;
  }
};
