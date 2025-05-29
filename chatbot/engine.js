import { substituteVariables } from '../utils/vars.js';
import { supabase } from '../services/db.js';
import axios from 'axios';
import vm from 'vm';

export async function processMessage(message, flow, vars, userId) {
  if (!flow || !flow.blocks || !flow.start) return flow?.onError?.content || 'Erro interno no bot';

  // Tenta carregar sessão
  let currentBlockId = flow.start;
  let isNewSession = false;
  let sessionVars = vars;

  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (session?.current_block && flow.blocks[session.current_block]) {
    currentBlockId = session.current_block;
    sessionVars = { ...vars, ...session.vars };
  } else {
    isNewSession = true;
    await supabase.from('sessions').upsert({
      user_id: userId,
      current_block: currentBlockId,
      last_flow_id: flow.id || null,
      vars: sessionVars,
      updated_at: new Date().toISOString()
    });
  }

  let response = '';
  let keepRunning = true;

  while (currentBlockId && keepRunning) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    let content = block.content ? substituteVariables(block.content, sessionVars) : '';

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
            const payload = JSON.parse(substituteVariables(JSON.stringify(block.body || {}), sessionVars));
            const apiRes = await axios({
              method: block.method || 'GET',
              url: substituteVariables(block.url, sessionVars),
              data: payload
            });
            sessionVars.responseStatus = apiRes.status;
            sessionVars.responseData = apiRes.data;

            if (block.script) {
              const sandbox = { response: apiRes.data, vars: sessionVars, output: '' };
              vm.createContext(sandbox);
              vm.runInContext(block.script, sandbox);
              response = sandbox.output;
            } else {
              response = JSON.stringify(apiRes.data);
            }
          } catch (apiErr) {
            sessionVars.responseStatus = apiErr?.response?.status || 500;
            sessionVars.responseData = apiErr?.response?.data || {};

            if (block.onErrorScript) {
              const sandbox = { error: apiErr, vars: sessionVars, output: '' };
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
        vars: sessionVars,
        updated_at: new Date().toISOString()
      });
      if (updateResult.error) {
        console.error('❌ Erro ao salvar sessão:', updateResult.error);
      }

      currentBlockId = nextBlock;
      keepRunning = !block.awaitUserInput;

      // Retorna logo se o bloco atual está esperando input do usuário
      if (block.awaitUserInput) break;

    } catch (err) {
      console.error('Erro no bloco:', currentBlockId, err);
      return flow.onError?.content || 'Erro no fluxo do bot.';
    }
  }

  return response;
}
