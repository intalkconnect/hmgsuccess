// services/db.js
import { createClient } from '@supabase/supabase-js'

let supabase = null

export async function initDB() {
  if (supabase) return

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('As variáveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY devem estar definidas')
  }

  supabase = createClient(url, key)

  // (Opcional) testar conexão
  const { error } = await supabase.from('messages').select('id').limit(1)
  if (error) {
    console.error('Erro ao conectar no Supabase:', error)
    throw error
  }
}

// Aqui exportamos também o próprio supabase para importações diretas
export function getSupabaseClient() {
  if (!supabase) {
    throw new Error('Supabase não inicializado. Chame initDB() antes.')
  }
  return supabase
}

// EXPORT EXTRA: expõe `supabase` direto
export { supabase }
