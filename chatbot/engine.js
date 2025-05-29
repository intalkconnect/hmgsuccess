import { substituteVariables } from '../utils/vars.js';
import { supabase } from '../services/db.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
import axios from 'axios';
import vm from 'vm';

export async function processMessage(message, flow, vars, userId) {
  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  let currentBlockId = flow.start;
  let sessionVars = { ...vars };

  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (session?.current_block && flow.blocks[session.current_block]) {
    currentBlockId = session.current_block;
    sessionVars = { ...sessionVars, ...session.vars };
  }

  const block = flow.blocks[currentBlockId];
  if (!block) return flow?.onError?.content || 'Erro no fluxo do bot.';

  const shouldWait = block.awaitResponse === true;
  const timeout = parseInt(block.awaitTimeInSeconds || '0', 10);
  const nextBlock = block.next ?? null;

  // Se o bloco precisa esperar e ainda não tem input do usuário, sai do processamento.
  if (shouldWait && !message) {
    return null;
  }

  // Se há mensagem do usuário, atualiza input.message
  if (message) {
    sessionVars.input = { message };
  }

  let response = '';
  try {
    const content = block.content ? substituteVariables(block.content, sessionVars) : '';

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
          const payload = JSON.parse(
            substituteVariables(JSON.stringify(block.body || {}), sessionVars)
          );
          const apiRes = await axios({
            method: block.method || 'GET',
            url: substituteVariables(block.url, sessionVars),
            data: payload,
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
          } else {
            throw apiErr;
          }
        }
        break;

      default:
        response = '[Bloco não reconhecido]';
    }

    // Envia mensagem
    if (response) {
      try {
        await sendWhatsappMessage({
          to: userId,
          type: 'text',
          content: { body: response },
        });
      } catch (err) {
        console.error('Erro ao enviar mensagem WhatsApp:', err?.response?.data || err.message);
      }
    }

    // Atualiza sessão para aguardar ou ir ao próximo bloco
    await supabase.from('sessions').upsert([{
      user_id: userId,
      current_block: shouldWait ? currentBlockId : nextBlock,
      last_flow_id: flow.id || null,
      vars: sessionVars,
      updated_at: new Date().toISOString(),
    }]);

    return response;

  } catch (err) {
    console.error('Erro no bloco:', currentBlockId, err);
    return flow?.onError?.content || 'Erro ao processar sua solicitação.';
  }
}
