// services/db.js
import pkg from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const { Pool } = pkg

export let pool

export const initDB = async () => {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL não está definida no .env')
  }

  pool = new Pool({ connectionString: url })

  // Teste simples de conexão
  try {
    const res = await pool.query('SELECT 1')
    console.log('✅ Conexão PostgreSQL OK')
  } catch (err) {
    console.error('❌ Erro ao conectar no PostgreSQL:', err)
    throw err
  }
}
