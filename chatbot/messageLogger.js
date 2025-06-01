// chatbot/messageLogger.js
import { supabase } from '../services/db.js'
import { randomUUID } from 'crypto'

export async function logOutgoingMessage(userId, type, content, flowId) {
  const { data, error } = await supabase
    .from('messages')
    .insert([{
      id: randomUUID(),
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
    }])
    .select('*') // << importante

  if (error) {
    console.error('❌ Erro ao salvar outgoing:', error)
    return null
  }

  return data?.[0] || null
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
