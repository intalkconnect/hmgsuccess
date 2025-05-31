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
export async function logOutgoingMessage(userId, type, content, flowId) {
  await supabase.from('messages').insert([{
    id:                    randomUUID(),           // gera um UUID para whatsapp_message_id
    user_id:               userId,
    whatsapp_message_id:   randomUUID(),           // agora NÃO é null
    direction:             'outgoing',
    type:                  type,
    content:               content,
    timestamp:             new Date().toISOString(),
    flow_id:               flowId || null,
    agent_id:              null,
    queue_id:              null,
    status:                'sent',
    metadata:              null,
    created_at:            new Date().toISOString(),
    updated_at:            new Date().toISOString()
  }]);
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
