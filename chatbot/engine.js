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

  let whatsappContent;
  if (type === 'text' && typeof content === 'string') {
    whatsappContent = { body: content };
  } else {
    whatsappContent = content;
  }

  return sendWhatsappMessage({ to, type, content: whatsappContent });
}

// processMessage corrigido: onerror retorna ao previousBlock, tratamento de 'despedida' e 'atendimento_humano'
export async function processMessage(message, flow, vars, rawUserId) {
  const userId = `${rawUserId}@c.wa.msginb.net`;

  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .single();

  // Configurações iniciais
  let currentBlockId = null;
  let sessionVars = { ...vars };

  // Se há sessão existente
  if (session?.current_block && flow.blocks[session.current_block]) {
    const storedBlock = session.current_block;
    sessionVars = { ...sessionVars, ...session.vars };

    // 1️⃣ Se estiver em atendimento humano, não responder (fica aguardando)
    if (storedBlock === 'atendimento_humano') {
      return null;
    }

    // 2️⃣ Se chegou no bloco 'despedida', reinicia o fluxo no próximo input e interrompe aqui
    if (storedBlock === 'despedida') {
      currentBlockId = flow.start;
      sessionVars = { ...vars }; // zera as variáveis (volta ao estado inicial)

      // Persiste a sessão voltando ao início
      await supabase.from('sessions').upsert([{
        user_id: userId,
        current_block: currentBlockId,
        last_flow_id: flow.id || null,
        vars: sessionVars,
        updated_at: new Date().toISOString(),
      }]);

      // Interrompe o processamento deste ciclo, esperando o próximo input para recomeçar em 'boas-vindas'
      return null;
    }

    // 3️⃣ Caso geral (nem humano nem 'despedida'), retoma o bloco armazenado
    const awaiting = flow.blocks[storedBlock];
    if (awaiting.awaitResponse) {
      if (!message) return null;
      sessionVars.lastUserMessage = message;

      // Avalia as ações condicionais para decidir o próximo bloco
      for (const action of awaiting.actions || []) {
        if (evaluateConditions(action.conditions, sessionVars)) {
          currentBlockId = action.next;
          break;
        }
      }
      // Se nenhuma ação bateu, usa defaultNext
      if (!currentBlockId && awaiting.defaultNext && flow.blocks[awaiting.defaultNext]) {
        console.warn(`⚠️ Nenhuma ação válida em '${storedBlock}', indo para defaultNext: ${awaiting.defaultNext}`);
        currentBlockId = awaiting.defaultNext;
      }
      // Se ainda não encontrou next, cai em onerror
      if (!currentBlockId && flow.blocks.onerror) {
        console.warn(`⚠️ Fallback para 'onerror'`);
        currentBlockId = 'onerror';
      }
    } else {
      // Se não aguardava resposta, permanece no mesmo bloco
      currentBlockId = storedBlock;
    }

    // Se ainda não definiu currentBlockId, faz fallback
    if (!currentBlockId) {
      console.warn(`⚠️ Sem transição válida, usando 'onerror' ou 'start'`);
      currentBlockId = flow.blocks.onerror ? 'onerror' : flow.start;
    }
  } else {
    // Primeira execução: inicia no bloco 'boas-vindas'
    currentBlockId = flow.start;
    await supabase.from('sessions').upsert([{
      user_id: userId,
      current_block: currentBlockId,
      last_flow_id: flow.id || null,
      vars: sessionVars,
      updated_at: new Date().toISOString(),
    }]);
  }

  let lastResponse = null;

  // Loop principal: executa até não haver mais currentBlockId
  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    let content = '';
    try {
      // PREPARA O CONTEÚDO (texto ou objeto JSON)
      if (block.content != null) {
        if (typeof block.content === 'string') {
          content = substituteVariables(block.content, sessionVars);
        } else {
          content = JSON.parse(
            substituteVariables(JSON.stringify(block.content), sessionVars)
          );
        }
      }

      // Executa tipo 'api_call' ou 'script' se for o caso
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
          break;
      }

      // ENVIA A MENSAGEM (texto, lista interativa etc.)
      if (
        content &&
        ['text','image','audio','video','file','document','location','interactive'].includes(block.type)
      ) {
        if (message?.id) await markAsReadAndTyping(message.id);
        if (block.sendDelayInSeconds) {
          await new Promise(r => setTimeout(r, block.sendDelayInSeconds * 1000));
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

      // DETERMINA O PRÓXIMO BLOCO
      let nextBlock;
      // 1) Se estiver em 'onerror', força retorno a 'previousBlock'
      if (currentBlockId === 'onerror' && sessionVars.previousBlock) {
        nextBlock = sessionVars.previousBlock;
      } else {
        // 2) Senão, avalia normalmente as ações do bloco
        nextBlock = null;
        for (const action of block.actions || []) {
          if (evaluateConditions(action.conditions, sessionVars)) {
            nextBlock = action.next;
            break;
          }
        }
        // 3) Se não encontrou action válida, tenta defaultNext
        if (!nextBlock && block.defaultNext && flow.blocks[block.defaultNext]) {
          nextBlock = block.defaultNext;
        }
        // 4) Se ainda nada, cai em 'onerror'
        if (!nextBlock && flow.blocks.onerror) {
          console.warn(`⚠️ Fallback para 'onerror'`);
          nextBlock = 'onerror';
        }
      }

      // RESOLVE POSSÍVEL PLACEHOLDER {previousBlock}
      let resolvedBlock = block.awaitResponse ? currentBlockId : nextBlock;
      if (typeof resolvedBlock === 'string' && resolvedBlock.includes('{')) {
        resolvedBlock = substituteVariables(resolvedBlock, sessionVars);
      }
      // VALIDA EXISTÊNCIA: se bloco não existir, volta para 'onerror'
      if (!flow.blocks[resolvedBlock] && flow.blocks.onerror) {
        console.warn(`⚠️ Bloco '${resolvedBlock}' inválido. Usando 'onerror'.`);
        resolvedBlock = 'onerror';
      }

      // ATUALIZA 'previousBlock' para evitar loops:
      // grava apenas se:
      // - o bloco atual NÃO for 'onerror'
      // - o próximo bloco NÃO for 'onerror'
      // - e se o próximo bloco for diferente do 'previousBlock' já armazenado
      if (
        currentBlockId !== 'onerror' &&
        resolvedBlock !== 'onerror' &&
        (!sessionVars.previousBlock || sessionVars.previousBlock !== resolvedBlock)
      ) {
        sessionVars.previousBlock = currentBlockId;
      }

      // PERSISTE SESSÃO ATUALIZADA
      await supabase.from('sessions').upsert([{
        user_id: userId,
        current_block: resolvedBlock,
        last_flow_id: flow.id || null,
        vars: sessionVars,
        updated_at: new Date().toISOString(),
      }]);

      // Se o bloco aguarda resposta, interrompe o loop para aguardar input
      if (block.awaitResponse) break;

      // Delay de saída, caso haja
      const delay = parseInt(block.awaitTimeInSeconds || '0', 10);
      if (delay > 0) await new Promise(r => setTimeout(r, delay * 1000));

      // Atualiza currentBlockId para a próxima iteração
      currentBlockId = resolvedBlock;
    } catch (err) {
      console.error('Erro no bloco', currentBlockId, err);
      return flow.onError?.content || 'Erro no fluxo do bot.';
    }
  }

  return lastResponse;
}
