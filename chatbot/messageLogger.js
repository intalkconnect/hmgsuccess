// engine/messageLogger.js
import { supabase } from '../services/db.js';
import { randomUUID } from 'crypto';

/**
 * Grava uma mensagem de saída (bot → usuário) na tabela `messages`.
 *
 * @param {string} userId    - ID do usuário (e.g. "5521990286724@w.msgcli.net")
 * @param {string} type      - Tipo de mensagem ("text", "image", etc.)
 * @param {string|object} content - Conteúdo (texto ou JSON para mídia)
 * @param {string|null} flowId - ID do fluxo que disparou esta mensagem
 */
// messageLogger.js

export async function logOutgoingMessage(userId, type, content, flowId) {
  const outgoingMessage = {
    id:                  randomUUID(),
    user_id:             userId,
    whatsapp_message_id: randomUUID(),
    direction:           'outgoing',
    type,
    content,
    timestamp:           new Date().toISOString(),
    flow_id:             flowId || null,
    agent_id:            null,
    queue_id:            null,
    status:              'sent',
    metadata:            null,
    created_at:          new Date().toISOString(),
    updated_at:          new Date().toISOString()
  }

  const { data, error } = await supabase.from('messages').insert([outgoingMessage]).select('*')
  if (error) console.error('❌ Erro ao gravar outgoing:', error)

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
