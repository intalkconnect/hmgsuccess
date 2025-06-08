import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;

export const initDB = async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL não está definida no .env');
  }

  pool = new Pool({ connectionString: url });

  try {
    await pool.query('SELECT 1');
    console.log('✅ Conexão PostgreSQL OK');
  } catch (err) {
    console.error('❌ Erro ao conectar no PostgreSQL:', err);
    throw err;
  }

  return pool;
};

export { pool }; // ✅ exportação única e correta
