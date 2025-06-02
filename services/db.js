import { supabase } from './db.js'

export async function salvarMensagem({ messageId, from, type, content }) {
  try {
    // Verifica se já existe a mensagem
    const { data: existente, error: erroBusca } = await supabase
      .from('messages')
      .select('id')
      .eq('whatsapp_message_id', messageId)
      .single()

    if (existente) {
      console.log('[ℹ️ Mensagem já existe no banco]');
      return;
    }

    // Se não existe, insere
    const { error: erroInsert } = await supabase.from('messages').insert([
      {
        whatsapp_message_id: messageId,
        from,
        type,
        content,
        created_at: new Date().toISOString(),
      }
    ])

    if (erroInsert) {
      console.error('❌ Erro ao inserir no Supabase:', erroInsert)
    } else {
      console.log('[✅ Mensagem salva no banco]')
    }
  } catch (err) {
    console.error('❌ Erro inesperado ao salvar mensagem:', err.message || err)
  }
}
