import { substituteVariables } from '../utils/vars.js';
import { supabase } from '../services/db.js';
import axios from 'axios';
import vm from 'vm';

export async function processMessage(message, flow, vars, userId) {
  if (!flow || !flow.blocks || !flow.start) return flow?.onError?.content || 'Erro interno no bot';

  // Tenta carregar sessão
  let currentBlockId = flow.start;
  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (session?.current_block && flow.blocks[session.current_block]) {
    currentBlockId = session.current_block;
    vars = { ...vars, ...session.vars };
  }

  let response = '';

  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    let content = block.content ? substituteVariables(block.content, vars) : '';

    try {
      switch (block.type) {
        case 'text':
        case 'image':
        case 'audio':
        case 'video':
        case 'file':
          response = content;
          break;

        case 'api_call':
          const payload = JSON.parse(substituteVariables(JSON.stringify(block.body || {}), vars));
          const apiRes = await axios({
            method: block.method || 'GET',
            url: substituteVariables(block.url, vars),
            data: payload
          });
          if (block.script) {
            const sandbox = { response: apiRes.data, vars };
            vm.createContext(sandbox);
            response = vm.runInContext(block.script, sandbox);
          } else {
            response = JSON.stringify(apiRes.data);
          }
          break;

        default:
          response = '[Bloco não reconhecido]';
      }

      // Atualiza sessão
      await supabase.from('sessions').upsert({
        user_id: userId,
        current_block: block.next || null,
        last_flow_id: flow.id || null,
        vars,
        updated_at: new Date().toISOString()
      });

      currentBlockId = block.next || null;
    } catch (err) {
      console.error('Erro no bloco:', currentBlockId, err);
      return flow.onError?.content || 'Erro no fluxo do bot.';
    }
  }

  return response;
}
