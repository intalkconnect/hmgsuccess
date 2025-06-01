// services/db.js
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

// 1) Carrega as variáveis de ambiente
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('As variáveis SUPABASE_URL e SUPABASE_KEY não foram definidas.')
}

// 2) Cria o client Supabase uma única vez
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// 3) initDB pode ficar opcional, só garantindo que `supabase` existe
export const initDB = async () => {
  // Se quiser testar a conexão logo de cara:
  try {
    await supabase.from('messages').select('id').limit(1)
    // se não der erro, está tudo certo
  } catch (error) {
    console.error('Erro ao conectar ao Supabase:', error)
    throw error
  }
}
