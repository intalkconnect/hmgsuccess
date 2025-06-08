// services/db.js
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Vamos usar o Pool do pg para gerenciar conexões
const { Pool } = pg;
export let dbPool;

export const initDB = async () => {
  // 1) Validar que as variáveis de ambiente existem
  const user = process.env.PG_USER;
  const host = process.env.PG_HOST;
  const database = process.env.PG_DATABASE;
  const password = process.env.PG_PASSWORD;
  const port = process.env.PG_PORT || 5432;

  if (!user || !host || !database || !password) {
    throw new Error(
      'As variáveis de ambiente PG_USER, PG_HOST, PG_DATABASE e PG_PASSWORD devem estar definidas no seu .env'
    );
  }

  // 2) Criar o pool de conexões
  dbPool = new Pool({
    user,
    host,
    database,
    password,
    port,
    // Opcional: configurações adicionais do pool
    max: 20, // máximo de clientes no pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  // 3) Testar a conexão
  try {
    const client = await dbPool.connect();
    // Teste simples - você pode ajustar para uma tabela específica do seu projeto
    await client.query('SELECT 1');
    client.release();
  } catch (error) {
    console.error('Erro ao conectar no PostgreSQL dentro de initDB():', error);
    throw error;
  }
};
