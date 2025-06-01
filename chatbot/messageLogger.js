// chatbot/messageLogger.js
import { supabase } from '../services/db.js'
import { randomUUID } from 'crypto'

// chatbot/messageLogger.js
export async function logOutgoingMessage(userId, type, content, flowId) {
  const { data, error } = await supabase.from('messages').insert([{
    user_id: userId,
    whatsapp_message_id: randomUUID(),
    direction: 'outgoing',
    type,
    content,
    timestamp: new Date().toISOString(),
    flow_id: flowId || null,
    agent_id: null,
    queue_id: null,
    status: 'sent',
    metadata: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }]).select('*') // 🔁 Garante retorno completo

  if (error) {
    console.error('❌ Erro ao gravar outgoing:', error)
    return null
  }
console.log('✅ Mensagem outgoing gravada:', data?.[0])

  return data?.[0] || null // 🔁 Retorna registro inteiro (com id e direction)
}

/**
 * Grava um “fallback” quando falha no envio de mídia.
 */
export async function logOutgoingFallback(userId, fallbackText, flowId) {
  await supabase.from('messages').insert([{
    id:                    randomUUID(),
    user_id:               userId,
    whatsapp_message_id:   randomUUID(),
    direction:             'outgoing',
    type:                  'text',
    content:               fallbackText,
    timestamp:             new Date().toISOString(),
    flow_id:               flowId || null,
    agent_id:              null,
    queue_id:              null,
    status:                'sent',
    metadata:              JSON.stringify({ fallback: true }),
    created_at:            new Date().toISOString(),
    updated_at:            new Date().toISOString()
  }]);
}
