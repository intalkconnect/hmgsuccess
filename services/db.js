// services/db.js
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

// Vamos exportar uma variável “supabase” que será atribuída dentro de initDB()
export let supabase

export const initDB = async () => {
  // 1) Validar que as variáveis de ambiente existem
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_KEY  // atenção: confira se no seu .env você definiu exatamente SUPABASE_KEY!
  if (!url || !key) {
    throw new Error(
      'As variáveis de ambiente SUPABASE_URL e SUPABASE_KEY devem estar definidas no seu .env'
    )
  }

  // 2) Criar o client Supabase (mesmo comportamento que você tinha antes)
  supabase = createClient(url, key)

  // 3) (Opcional) testar a conexão imediatamente, para levantar erro cedo
  const { error } = await supabase.from('messages').select('id').limit(1)
  if (error) {
    console.error('Erro ao conectar no Supabase dentro de initDB():', error)
    throw error
  }
}
