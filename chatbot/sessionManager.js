// engine/sessionManager.js
import { supabase } from '../services/db.js';

export async function loadSession(userId) {
  const { data } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .single();
  return data || {};
}

export async function saveSession(userId, currentBlock, flowId, vars) {
  await supabase.from('sessions').upsert([{
    user_id: userId,
    current_block: currentBlock,
    last_flow_id: flowId,
    vars,
    updated_at: new Date().toISOString(),
  }]);
}
