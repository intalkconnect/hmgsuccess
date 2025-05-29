import { substituteVariables } from '../utils/vars.js';
import { supabase } from '../services/db.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
import { sendWebchatMessage } from '../services/sendWebchatMessage.js';
import axios from 'axios';
import vm from 'vm';

/**
 * Avalia um array de condições contra as variáveis de sessão.
 */
function evaluateConditions(conditions = [], sessionVars = {}) {
  for (const condition of conditions) {
    const { type, variable, value } = condition;
    const actualValue = sessionVars[variable];

    switch (type) {
      case 'exists':
        if (actualValue == null) return false;
        break;
      case 'not_exists':
        if (actualValue != null) return false;
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

/**
 * Envia a mensagem no canal correto.
 */
async function sendMessageByChannel(channel, to, type, content) {
  switch (channel) {
    case 'webchat':
      return sendWebchatMessage({ to, content });
    case 'whatsapp':
    default:
      if (type === 'text' && typeof content === 'string') {
        return sendWhatsappMessage({ to, type, content: { body: content } });
      }
      return sendWhatsappMessage({ to, type, content });
  }
}

/**
 * Processa cada mensagem do usuário, navegando pelo flow
 * e executando actions sempre que houver awaitResponse ou saídas.
 */
export async function processMessage(message, flow, vars, rawUserId) {
  const userId = `${rawUserId}@c.wa.msginb.net`;

  // Validação básica do flow
  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  // Carrega sessão existente
  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .single();

  let currentBlockId = flow.start;
  let sessionVars = { ...vars };

  // Se já existia sessão e bloco corrente
  if (session?.current_block && flow.blocks[session.current_block]) {
    const awaitingBlock = flow.blocks[session.current_block];
    sessionVars = { ...sessionVars, ...session.vars };

    // Se estamos aguardando resposta desse bloco
    if (awaitingBlock.awaitResponse) {
      // sem mensagem, paramos aqui para esperar
      if (!message) {
        return null;
      }
      // grava resposta e decide próximo bloco via actions
      sessionVars.lastUserMessage = message;
      for (const action of awaitingBlock.actions || []) {
        if (evaluateConditions(action.conditions, sessionVars)) {
          currentBlockId = action.next;
          break;
        }
      }
    } else {
      // não aguardava resposta: retomamos do próprio bloco
      currentBlockId = session.current_block;
    }
  } else {
    // primeira vez: grava sessão inicial
    await supabase.from('sessions').upsert([{
      user_id: userId,
      current_block: currentBlockId,
      last_flow_id: flow.id || null,
      vars: sessionVars,
      updated_at: new Date().toISOString(),
    }]);
  }

  let lastResponse = null;

  // Loop principal pelos blocos
  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    let responseContent = '';

    try {
      // Substitui variáveis no conteúdo
      if (block.content != null) {
        if (typeof block.content === 'string') {
          responseContent = substituteVariables(block.content, sessionVars);
        } else {
          responseContent = JSON.parse(
            substituteVariables(JSON.stringify(block.content), sessionVars)
          );
        }
      }

      // Executa cada tipo de bloco
      switch (block.type) {
        case 'text':
        case 'image':
        case 'audio':
        case 'video':
        case 'file':
        case 'document':
        case 'location':
          // já temos responseContent pronto
          break;

        case 'api_call':
          // montagem de URL e payload
          {
            const url = substituteVariables(block.url, sessionVars);
            const payload = JSON.parse(
              substituteVariables(JSON.stringify(block.body || {}), sessionVars)
            );
            const apiRes = await axios({
              method: block.method || 'GET',
              url,
              data: payload,
            });
            sessionVars.responseStatus = apiRes.status;
            sessionVars.responseData = apiRes.data;

            if (block.script) {
              const sandbox = { response: apiRes.data, vars: sessionVars, output: '' };
              vm.createContext(sandbox);
              vm.runInContext(block.script, sandbox);
              responseContent = sandbox.output;
            } else {
              responseContent = JSON.stringify(apiRes.data);
            }

            if (block.outputVar) {
              sessionVars[block.outputVar] = responseContent;
            }
            if (block.statusVar) {
              sessionVars[block.statusVar] = apiRes.status;
            }
          }
          break;

        case 'script':
          {
            const sandbox = { vars: sessionVars, output: '' };
            const fullScript = `
              ${block.code}
              output = ${block.function};
            `;
            vm.createContext(sandbox);
            vm.runInContext(fullScript, sandbox);
            responseContent = sandbox.output?.toString() || '';
            if (block.outputVar) {
              sessionVars[block.outputVar] = sandbox.output;
            }
          }
          break;

        default:
          responseContent = '[Bloco não reconhecido]';
      }

      // Envia a resposta, se for um tipo suportado
      if (responseContent && ['text','image','audio','video','file','document','location'].includes(block.type)) {
        await sendMessageByChannel(
          sessionVars.channel || 'whatsapp',
          userId,
          block.type,
          responseContent
        );
        lastResponse = responseContent;
      }

      // Decide próximo bloco via actions (sempre)
      let nextBlockId = null;
      for (const action of block.actions || []) {
        if (evaluateConditions(action.conditions, sessionVars)) {
          nextBlockId = action.next;
          break;
        }
      }

      // Atualiza sessão antes de prosseguir
      await supabase.from('sessions').upsert([{
        user_id: userId,
        current_block: block.awaitResponse ? currentBlockId : nextBlockId,
        last_flow_id: flow.id || null,
        vars: sessionVars,
        updated_at: new Date().toISOString(),
      }]);

      // Se precisa esperar resposta, interrompe aqui
      if (block.awaitResponse) {
        break;
      }

      // Se tem timeout configurado, aplica delay
      const timeoutSec = parseInt(block.awaitTimeInSeconds || '0', 10);
      if (timeoutSec > 0) {
        await new Promise(r => setTimeout(r, timeoutSec * 1000));
      }

      // Avança para o próximo bloco
      currentBlockId = nextBlockId;
    } catch (err) {
      console.error('Erro no bloco', currentBlockId, err);
      return flow.onError?.content || 'Erro no fluxo do bot.';
    }
  }

  return lastResponse;
}
