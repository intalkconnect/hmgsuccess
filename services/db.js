// services/db.js
import { createClient } from '@supabase/supabase-js'

let supabase = null

export async function initDB() {
  if (supabase) return

  // Usa a service_role_key para ter permissão de leitura/gravação total
  supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // (Opcional) você pode testar a conexão aqui:
  const { data, error } = await supabase.from('messages').select('id').limit(1)
  if (error) {
    console.error('Erro ao conectar ao Supabase:', error)
    throw error
  }
}

export function getSupabaseClient() {
  if (!supabase) {
    throw new Error('Supabase não inicializado. Chamou initDB()?')
  }
  return supabase
}
