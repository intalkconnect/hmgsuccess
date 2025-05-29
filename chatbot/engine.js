import { substituteVariables } from '../utils/vars.js';
import { supabase } from '../services/db.js';
import axios from 'axios';
import vm from 'vm';

export async function processMessage(message, flow, vars, userId) {
  if (!flow || !flow.blocks || !flow.start) return flow?.onError?.content || 'Erro interno no bot';

  // Tenta carregar sessão
  let currentBlockId = flow.start;
  let isNewSession = false;
  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (session?.current_block && flow.blocks[session.current_block]) {
    currentBlockId = session.current_block;
    vars = { ...vars, ...session.vars };
  } else {
    isNewSession = true;
  }

  let response = '';
  let keepRunning = true;

  while (currentBlockId && keepRunning) {
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
          try {
            const payload = JSON.parse(substituteVariables(JSON.stringify(block.body || {}), vars));
            const apiRes = await axios({
              method: block.method || 'GET',
              url: substituteVariables(block.url, vars),
              data: payload
            });
            vars.responseStatus = apiRes.status;
            vars.responseData = apiRes.data;

            if (block.script) {
              const sandbox = { response: apiRes.data, vars, output: '' };
              vm.createContext(sandbox);
              vm.runInContext(block.script, sandbox);
              response = sandbox.output;
            } else {
              response = JSON.stringify(apiRes.data);
            }
          } catch (apiErr) {
            vars.responseStatus = apiErr?.response?.status || 500;
            vars.responseData = apiErr?.response?.data || {};

            if (block.onErrorScript) {
              const sandbox = { error: apiErr, vars, output: '' };
              vm.createContext(sandbox);
              vm.runInContext(block.onErrorScript, sandbox);
              response = sandbox.output;
              break;
            }

            throw apiErr;
          }
          break;

        default:
          response = '[Bloco não reconhecido]';
      }

      const nextBlock = block.next ?? null;
      const updateResult = await supabase.from('sessions').upsert({
        user_id: userId,
        current_block: nextBlock,
        last_flow_id: flow.id || null,
        vars,
        updated_at: new Date().toISOString()
      });
      if (updateResult.error) {
        console.error('❌ Erro ao salvar sessão:', updateResult.error);
      }

      currentBlockId = nextBlock;
      keepRunning = !block.awaitUserInput;

    } catch (err) {
      console.error('Erro no bloco:', currentBlockId, err);
      return flow.onError?.content || 'Erro no fluxo do bot.';
    }
  }

  if (!currentBlockId) {
    console.log('🔁 Reiniciando sessão para usuário:', userId);
    const resetResult = await supabase.from('sessions').upsert({
      user_id: userId,
      current_block: flow.start,
      last_flow_id: flow.id || null,
      vars,
      updated_at: new Date().toISOString()
    });
    if (resetResult.error) {
      console.error('❌ Erro ao resetar sessão:', resetResult.error);
    }
  }

  return response;
}
