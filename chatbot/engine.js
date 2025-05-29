import { substituteVariables } from '../utils/vars.js';
import { supabase } from '../services/db.js';
import { sendWhatsappMessage, markAsReadAndTyping } from '../services/sendWhatsappMessage.js';
import { sendWebchatMessage } from '../services/sendWebchatMessage.js';
import axios from 'axios';
import vm from 'vm';

/**
 * Avalia condições de ação no bloco
 */
function evaluateConditions(conditions = [], sessionVars = {}) {
  for (const { type, variable, value } of conditions) {
    const actual = sessionVars[variable];
    switch (type) {
      case 'exists':       if (actual == null) return false; break;
      case 'not_exists':   if (actual != null) return false; break;
      case 'equals':       if (actual != value) return false; break;
      case 'not_equals':   if (actual == value) return false; break;
      case 'contains':     if (!String(actual).includes(value)) return false; break;
      case 'regex':        if (!new RegExp(value).test(actual)) return false; break;
      case 'greater_than': if (!(parseFloat(actual) > parseFloat(value))) return false; break;
      case 'less_than':    if (!(parseFloat(actual) < parseFloat(value))) return false; break;
      default: return false;
    }
  }
  return true;
}

/**
 * Envia mensagem pelo canal apropriado, marcando read+typing no WhatsApp
 */
async function sendMessageByChannel(channel, to, type, content, messageId) {
  if (channel === 'webchat') {
    return sendWebchatMessage({ to, content });
  }
  // WhatsApp: dispara read+typing antes de enviar
  if (messageId) {
    try {
      await markAsReadAndTyping(messageId);
    } catch (e) {
      console.error('typing indicator erro:', e);
    }
  }
  let payloadContent = content;
  if (type === 'text' && typeof content === 'string') {
    payloadContent = { body: content };
  }
  return sendWhatsappMessage({ to, type, content: payloadContent });
}

/**
 * Processa a mensagem de entrada de acordo com o flow definido
 */
export async function processMessage(message, flow, vars, rawUserId) {
  const userId = `${rawUserId}@c.wa.msginb.net`;
  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  // Carrega ou inicia sessão
  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .single();
  let currentBlockId = session?.current_block || flow.start;
  let sessionVars = session?.vars ? { ...vars, ...session.vars } : { ...vars };
  let lastResponse = null;
  const validTypes = ['text','image','audio','video','file','document','location','interactive'];

  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

        // 1) Se aguardando resposta, processa input do usuário e avança
    if (block.awaitResponse && message != null) {
      sessionVars.lastUserMessage = message;
      // escolhe próxima ação com base nas condições
      for (const action of block.actions || []) {
        if (evaluateConditions(action.conditions, sessionVars)) {
          currentBlockId = action.next;
          break;
        }
      }
      // grava nova posição na sessão
      await supabase.from('sessions').upsert([{
        user_id: userId,
        current_block: currentBlockId,
        vars: sessionVars,
        last_flow_id: flow.id || null,
        updated_at: new Date().toISOString()
      }]);
      // continua o loop para processar imediatamente o novo bloco
      continue;
    }

    // 2) Prepara conteúdo
    let content = '';
    if (block.content != null) {
      content = typeof block.content === 'string'
        ? substituteVariables(block.content, sessionVars)
        : JSON.parse(substituteVariables(JSON.stringify(block.content), sessionVars));
    }

    // 3) Executa api_call ou script
    if (block.type === 'api_call') {
      const url = substituteVariables(block.url, sessionVars);
      const bodyPayload = JSON.parse(substituteVariables(JSON.stringify(block.body||{}), sessionVars));
      const res = await axios({ method: block.method||'GET', url, data: bodyPayload });
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
    } else if (block.type === 'script') {
      const sandbox = { vars: sessionVars, output: '' };
      const code = `${block.code}\noutput = ${block.function};`;
      vm.createContext(sandbox);
      vm.runInContext(code, sandbox);
      content = sandbox.output?.toString() || '';
      if (block.outputVar) sessionVars[block.outputVar] = sandbox.output;
    }

    // 4) Atraso antes de enviar mensagem (sendDelayInSeconds)
    const sendDelay = parseInt(block.sendDelayInSeconds||'0',10);
    if (sendDelay > 0) await new Promise(r => setTimeout(r, sendDelay*1000));

    // 5) Envia mensagem (text, media, location, interactive)
    if (content && validTypes.includes(block.type)) {
      try {
        await sendMessageByChannel(
          sessionVars.channel||'whatsapp',
          userId,
          block.type,
          content,
          sessionVars.lastMessageId
        );
        lastResponse = content;
      } catch (err) {
        console.error('Erro no envio:', err);
        const fallback = typeof content==='object' && content.url
          ? `Conteúdo: ${content.url}`
          : `${content}`;
        await sendMessageByChannel(
          sessionVars.channel||'whatsapp',
          userId,
          'text',
          fallback,
          sessionVars.lastMessageId
        );
        lastResponse = fallback;
      }
    }

    // 6) Atraso após envio e antes de continuar (awaitTimeInSeconds)
    const contDelay = parseInt(block.awaitTimeInSeconds||'0',10);
    if (!block.awaitResponse && contDelay > 0) await new Promise(r => setTimeout(r, contDelay*1000));

    // 7) Próximo bloco por ação ou default
    let nextBlock = null;
    for (const action of block.actions || []) {
      if (evaluateConditions(action.conditions, sessionVars)) {
        nextBlock = action.next;
        break;
      }
    }
    if (!nextBlock && !block.awaitResponse) {
      nextBlock = block.next || null;
    }

    // 8) Atualiza sessão
    await supabase.from('sessions').upsert([{
      user_id: userId,
      current_block: block.awaitResponse ? currentBlockId : nextBlock,
      last_flow_id: flow.id||null,
      vars: sessionVars,
      updated_at: new Date().toISOString()
    }]);

    // 9) Se bloco aguarda input, sai; senão continua
    if (block.awaitResponse) break;
    currentBlockId = nextBlock;
  }

  return lastResponse;
}
