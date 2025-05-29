import { substituteVariables } from '../utils/vars.js';
import { supabase } from '../services/db.js';
import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
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
 * Dispara a API certa dependendo do canal
 */
async function sendMessageByChannel(channel, to, type, content) {
  if (channel === 'webchat') {
    return sendWebchatMessage({ to, content });
  }
  // whatsapp
  if (type === 'text' && typeof content === 'string') {
    return sendWhatsappMessage({ to, type, content: { body: content } });
  }
  return sendWhatsappMessage({ to, type, content });
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

  // se já tinha sessão e bloco configurado...
  if (session?.current_block && flow.blocks[session.current_block]) {
    const awaiting = flow.blocks[session.current_block];
    sessionVars = { ...sessionVars, ...session.vars };

    if (awaiting.awaitResponse) {
      // aguardando resposta: sem mensagem, volta null
      if (!message) return null;
      // grava a resposta do usuário
      sessionVars.lastUserMessage = message;
      // escolhe próximo pelas actions
      for (const action of awaiting.actions || []) {
        if (evaluateConditions(action.conditions, sessionVars)) {
          currentBlockId = action.next;
          break;
        }
      }
    } else {
      // não aguardava: continua deste bloco
      currentBlockId = session.current_block;
    }
  } else {
    // primeira vez: grava sessão
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
          // text, image, audio, document, location: content já está pronto
          break;
      }

      // envia mensagem (com catch específico para mídias)
      if (content && ['text','image','audio','video','file','document','location'].includes(block.type)) {
        try {
          await sendMessageByChannel(
            sessionVars.channel || 'whatsapp',
            userId,
            block.type,
            content
          );
        } catch (mediaErr) {
          console.error('❌ Falha ao enviar mídia:', mediaErr);
          // fallback: envia URL ou texto simples
          const fallback = typeof content === 'object' && content.url
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

      // determina próximo bloco via actions (sempre)
      let nextBlock = null;
      for (const action of block.actions || []) {
        if (evaluateConditions(action.conditions, sessionVars)) {
          nextBlock = action.next;
          break;
        }
      }
      // nunca deixe undefined: se não houver action, cai no onError
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

      // se aguarda resposta, interrompe aqui
      if (block.awaitResponse) break;

      // respeita timeout de saída
      const delay = parseInt(block.awaitTimeInSeconds || '0', 10);
      if (delay > 0) await new Promise(r => setTimeout(r, delay*1000));

      currentBlockId = nextBlock;

    } catch (err) {
      console.error('Erro no bloco', currentBlockId, err);
      return flow.onError?.content || 'Erro no fluxo do bot.';
    }
  }

  return lastResponse;
}
