import { substituteVariables } from '../utils/vars.js';
import { supabase } from '../services/db.js';
import { sendWhatsappMessage, markAsReadAndTyping } from '../services/sendWhatsappMessage.js';
import { sendWebchatMessage } from '../services/sendWebchatMessage.js';
import axios from 'axios';
import vm from 'vm';

/**
 * Avalia condições de ação
 */
function evaluateConditions(conditions = [], sessionVars = {}) {
  for (const { type, variable, value } of conditions) {
    const actual = sessionVars[variable];
    switch (type) {
      case 'exists':
        if (actual == null) return false;
        break;
      case 'not_exists':
        if (actual != null) return false;
        break;
      case 'equals':
        if (actual != value) return false;
        break;
      case 'not_equals':
        if (actual == value) return false;
        break;
      case 'contains':
        if (!String(actual).includes(value)) return false;
        break;
      case 'regex':
        if (!new RegExp(value).test(actual)) return false;
        break;
      case 'greater_than':
        if (!(parseFloat(actual) > parseFloat(value))) return false;
        break;
      case 'less_than':
        if (!(parseFloat(actual) < parseFloat(value))) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

/**
 * Envia mensagem no canal apropriado
 */
async function sendMessageByChannel(channel, to, type, content) {
  if (channel === 'webchat') {
    return sendWebchatMessage({ to, content });
  }

  // Whatsapp: texto simples ou objeto multimídia/interactive
  let whatsappContent;
  if (type === 'text' && typeof content === 'string') {
    whatsappContent = { body: content };
  } else {
    whatsappContent = content;
  }

  return sendWhatsappMessage({ to, type, content: whatsappContent });
}

/**
 * Processa mensagem do usuário, navega pelo flow e nunca deixa next undefined.
 */
export async function processMessage(message, flow, vars, rawUserId) {
  const userId = `${rawUserId}@c.wa.msginb.net`;

  // validação inicial
  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  // busca sessão existente
  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .single();

  let currentBlockId = flow.start;
  let sessionVars = { ...vars };

  // retoma sessão se houver bloco pendente
  if (session?.current_block && flow.blocks[session.current_block]) {
    const awaiting = flow.blocks[session.current_block];
    sessionVars = { ...sessionVars, ...session.vars };

    if (awaiting.awaitResponse) {
      if (!message) return null;
      sessionVars.lastUserMessage = message;
      for (const action of awaiting.actions || []) {
        if (evaluateConditions(action.conditions, sessionVars)) {
          currentBlockId = action.next;
          break;
        }
      }
    } else {
      currentBlockId = session.current_block;
    }
  } else {
    // primeira vez
    await supabase.from('sessions').upsert([{
      user_id: userId,
      current_block: currentBlockId,
      last_flow_id: flow.id || null,
      vars: sessionVars,
      updated_at: new Date().toISOString(),
    }]);
  }

  let lastResponse = null;

  // loop principal
  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    let content = '';

    try {
      // prepara conteúdo (string ou objeto)
      if (block.content != null) {
        if (typeof block.content === 'string') {
          content = substituteVariables(block.content, sessionVars);
        } else {
          content = JSON.parse(
            substituteVariables(JSON.stringify(block.content), sessionVars)
          );
        }
      }

      // executa tipos especiais
      switch (block.type) {
        case 'api_call': {
          const url = substituteVariables(block.url, sessionVars);
          const payload = JSON.parse(
            substituteVariables(JSON.stringify(block.body || {}), sessionVars)
          );
          const res = await axios({ method: block.method || 'GET', url, data: payload });
          sessionVars.responseStatus = res.status;
          sessionVars.responseData = res.data;
          if (block.script) {
            const sandbox = { response: res.data, vars: sessionVars, output: '' };
            vm.createContext(sandbox);
            vm.runInContext(block.script, sandbox);
            content = sandbox.output;
          } else {
            content = JSON.stringify(res.data);
          }
          if (block.outputVar) sessionVars[block.outputVar] = content;
          if (block.statusVar) sessionVars[block.statusVar] = res.status;
          break;
        }
        case 'script': {
          const sandbox = { vars: sessionVars, output: '' };
          const code = `${block.code}\noutput = ${block.function};`;
          vm.createContext(sandbox);
          vm.runInContext(code, sandbox);
          content = sandbox.output?.toString() || '';
          if (block.outputVar) sessionVars[block.outputVar] = sandbox.output;
          break;
        }
        default:
          // text, image, audio, video, file, document, location, interactive
          break;
      }

      // envia mensagem
      if (content && ['text','image','audio','video','file','document','location','interactive'].includes(block.type)) {
        // typing indicator
        if (message?.id) {
          await markAsReadAndTyping(message.id);
        }

        // delay customizado
        if (block.sendDelayInSeconds) {
          await new Promise(res => setTimeout(res, block.sendDelayInSeconds * 1000));
        }

        try {
          await sendMessageByChannel(
            sessionVars.channel || 'whatsapp',
            userId,
            block.type,
            content
          );
        } catch (mediaErr) {
          console.error('❌ Falha ao enviar mídia:', mediaErr);
          const fallback = (typeof content === 'object' && content.url)
            ? `Aqui está seu conteúdo: ${content.url}`
            : `Aqui está sua mensagem: ${content}`;
          await sendMessageByChannel(
            sessionVars.channel || 'whatsapp',
            userId,
            'text',
            fallback
          );
        }
        lastResponse = content;
      }

      // determina próximo bloco
      let nextBlock = null;
      for (const action of block.actions || []) {
        if (evaluateConditions(action.conditions, sessionVars)) {
          nextBlock = action.next;
          break;
        }
      }
      if (!nextBlock && block.awaitResponse === false) {
        console.warn(`⚠️ Sem ação de saída para bloco ${currentBlockId}`);
      }

      // atualiza sessão
      await supabase.from('sessions').upsert([{
        user_id: userId,
        current_block: block.awaitResponse ? currentBlockId : nextBlock,
        last_flow_id: flow.id || null,
        vars: sessionVars,
        updated_at: new Date().toISOString(),
      }]);

      if (block.awaitResponse) break;

      // timeout de saída
      const delay = parseInt(block.awaitTimeInSeconds || '0', 10);
      if (delay > 0) await new Promise(r => setTimeout(r, delay * 1000));

      currentBlockId = nextBlock;

    } catch (err) {
      console.error('Erro no bloco', currentBlockId, err);
      return flow.onError?.content || 'Erro no fluxo do bot.';
    }
  }

  return lastResponse;
}
