import { supabase } from '../../services/db.js';

export async function getSession(userId, flow, vars) {
  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (session) {
    return {
      current_block: session.current_block,
      vars: { ...vars, ...session.vars }
    };
  }

  // Cria nova sessão
  await supabase.from('sessions').upsert([{ user_id: userId, current_block: flow.start, vars, updated_at: new Date().toISOString() }]);
  return { current_block: flow.start, vars };
}

export async function saveSession(userId, current_block, flow_id, vars) {
  return supabase.from('sessions').upsert([{ user_id, current_block, last_flow_id: flow_id, vars, updated_at: new Date().toISOString() }]);
}
