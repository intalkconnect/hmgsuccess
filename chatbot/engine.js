import { substituteVariables } from '../utils/vars.js';
import { supabase } from '../services/db.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
import axios from 'axios';
import vm from 'vm';

function evaluateConditions(conditions = [], sessionVars = {}) {
  for (const condition of conditions) {
    const { type, variable, value } = condition;
    const actualValue = sessionVars[variable];

    switch (type) {
      case 'exists':
        if (actualValue === undefined || actualValue === null) return false;
        break;
      case 'not_exists':
        if (actualValue !== undefined && actualValue !== null) return false;
        break;
      case 'equals':
        if (actualValue != value) return false;
        break;
      case 'not_equals':
        if (actualValue == value) return false;
        break;
      case 'contains':
        if (!String(actualValue).includes(value)) return false;
        break;
      case 'regex':
        if (!new RegExp(value).test(actualValue)) return false;
        break;
      case 'greater_than':
        if (!(parseFloat(actualValue) > parseFloat(value))) return false;
        break;
      case 'less_than':
        if (!(parseFloat(actualValue) < parseFloat(value))) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

export async function processMessage(message, flow, vars, userId) {
  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  let currentBlockId = flow.start;
  let sessionVars = vars;
  let lastResponse = null;

  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (session?.current_block && flow.blocks[session.current_block]) {
    currentBlockId = session.current_block;
    sessionVars = { ...vars, ...session.vars };

    const awaitingBlock = flow.blocks[currentBlockId];
    if (awaitingBlock.awaitResponse && message) {
      sessionVars.lastUserMessage = message;
      currentBlockId = awaitingBlock.next;
    } else if (awaitingBlock.awaitResponse && !message) {
      return null;
    }
  } else {
    await supabase.from('sessions').upsert([{
      user_id: userId,
      current_block: currentBlockId,
      last_flow_id: flow.id || null,
      vars: sessionVars,
      updated_at: new Date().toISOString(),
    }]);
  }

  let stop = false;

  while (currentBlockId && !stop) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    let response = '';
    try {
      const content = block.content
        ? substituteVariables(block.content, sessionVars)
        : '';

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
            const url = substituteVariables(block.url, sessionVars);

            console.log(`🌐 Chamando API: ${url}`);
            console.log(`📦 Payload:`, payload);

            const apiRes = await axios({
              method: block.method || 'GET',
              url,
              data: payload,
            });

            console.log('✅ Resposta da API:', apiRes.data);

            sessionVars.responseStatus = apiRes.status;
            sessionVars.responseData = apiRes.data;

            if (block.script) {
              const sandbox = {
                response: apiRes.data,
                vars: sessionVars,
                output: '',
              };
              vm.createContext(sandbox);
              vm.runInContext(block.script, sandbox);
              response = sandbox.output;
            } else {
              response = JSON.stringify(apiRes.data);
            }

            if (block.outputVar && response !== undefined) {
              sessionVars[block.outputVar] = response;
            }
            if (block.statusVar && apiRes.status !== undefined) {
              sessionVars[block.statusVar] = apiRes.status;
            }

          } catch (apiErr) {
            console.error('❌ Erro na API:', apiErr?.response?.data || apiErr.message);
            console.error('🔁 URL usada:', block.url);

            const statusCode = apiErr?.response?.status || 500;
            const errorData = apiErr?.response?.data || {};

            sessionVars.responseStatus = statusCode;
            sessionVars.responseData = errorData;

            if (block.statusVar) {
              sessionVars[block.statusVar] = statusCode;
            }

            if (block.onErrorScript) {
              const sandbox = {
                error: apiErr,
                vars: sessionVars,
                output: '',
              };
              vm.createContext(sandbox);
              vm.runInContext(block.onErrorScript, sandbox);
              response = sandbox.output;

              if (block.outputVar && response !== undefined) {
                sessionVars[block.outputVar] = response;
              }
            } else {
              throw apiErr;
            }
          }
          break;

        case 'script':
          try {
            const sandbox = {
              vars: sessionVars,
              output: '',
            };

            const fullScript = `
              ${block.code}
              output = ${block.function};
            `;

            vm.createContext(sandbox);
            vm.runInContext(fullScript, sandbox);

            if (block.outputVar && sandbox.output !== undefined) {
              sessionVars[block.outputVar] = sandbox.output;
            }

            response = sandbox.output?.toString?.() || '';
          } catch (err) {
            console.error('❌ Erro ao executar bloco script:', err);
            response = '⚠️ Erro ao executar script do bot.';
          }
          break;

        default:
          response = '[Bloco não reconhecido]';
      }

      if (response) {
        try {
          await sendWhatsappMessage({
            to: userId,
            type: 'text',
            content: { body: response },
          });
          lastResponse = response;
        } catch (err) {
          console.error('Erro ao enviar mensagem WhatsApp:', err?.response?.data || err.message);
        }
      }

      // PRIORITÁRIO: verificar actions encadeadas por ordem
      let nextBlock = block.next ?? null;
      if (block.actions && Array.isArray(block.actions)) {
        for (const action of block.actions) {
          if (evaluateConditions(action.conditions, sessionVars)) {
            nextBlock = action.next;
            break;
          }
        }
      }

      const shouldWait = block.awaitResponse === true;
      const timeout = parseInt(block.awaitTimeInSeconds || '0', 10);

      await supabase.from('sessions').upsert([{
        user_id: userId,
        current_block: shouldWait ? currentBlockId : nextBlock,
        last_flow_id: flow.id || null,
        vars: sessionVars,
        updated_at: new Date().toISOString(),
      }]);

      if (shouldWait) {
        stop = true;
      } else if (timeout > 0) {
        await new Promise((resolve) => setTimeout(resolve, timeout * 1000));
        currentBlockId = nextBlock;
      } else {
        currentBlockId = nextBlock;
      }
    } catch (err) {
      console.error('Erro no bloco:', currentBlockId, err);
      return flow.onError?.content || 'Erro no fluxo do bot.';
    }
  }

  return lastResponse;
}
