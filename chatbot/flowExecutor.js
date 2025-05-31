// engine/flowExecutor.js
import { substituteVariables } from '../utils/vars.js';
import axios from 'axios';
import vm from 'vm';
import { evaluateConditions, determineNextBlock } from './utils.js';
import { loadSession, saveSession } from './sessionManager.js';
import { sendMessageByChannel, markAsReadIfNeeded } from './messenger.js';

export async function runFlow({ message, flow, vars, rawUserId }) {
  const userId = `${rawUserId}@c.wa.msginb.net`;
  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  // 1) Carrega sessão existente
  const session = await loadSession(userId);
  let sessionVars = { ...vars, ...(session.vars || {}) };
  let currentBlockId = null;

  // 2) Se já estiver em atendimento humano, bloqueia e salva
  if (session.current_block === 'atendimento_humano') {
    await saveSession(userId, 'atendimento_humano', flow.id, session.vars || {});
    return null;
  }

  // 3) Determina o bloco inicial (retoma sessão ou inicia)
  if (session.current_block && flow.blocks[session.current_block]) {
    const storedBlock = session.current_block;
    if (storedBlock === 'despedida') {
      currentBlockId = flow.start;
      sessionVars = {};
      sessionVars.lastUserMessage = message;
    } else {
      const awaiting = flow.blocks[storedBlock];
      if (awaiting.awaitResponse) {
        if (!message) return null;
        sessionVars.lastUserMessage = message;
        // avalia ações condicionais
        for (const action of awaiting.actions || []) {
          if (evaluateConditions(action.conditions, sessionVars)) {
            currentBlockId = action.next;
            break;
          }
        }
        // fallback defaultNext ou onerror
        if (!currentBlockId && awaiting.defaultNext && flow.blocks[awaiting.defaultNext]) {
          currentBlockId = awaiting.defaultNext;
        }
        if (!currentBlockId && flow.blocks.onerror) {
          currentBlockId = 'onerror';
        }
      } else {
        currentBlockId = storedBlock;
      }
    }
  } else {
    currentBlockId = flow.start;
  }

  let lastResponse = null;

  // 4) Loop principal de execução do bloco
  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    // 4.1) Se for atendimento humano, salva e interrompe
    if (block.type === 'human') {
      await saveSession(userId, 'atendimento_humano', flow.id, sessionVars);
      return null;
    }

    // 4.2) Prepara conteúdo (texto, objeto JSON etc.)
    let content = '';
    if (block.content != null) {
      content = typeof block.content === 'string'
        ? substituteVariables(block.content, sessionVars)
        : JSON.parse(substituteVariables(JSON.stringify(block.content), sessionVars));
    }

    // 4.3) Executa api_call ou script
    if (block.type === 'api_call') {
      const url = substituteVariables(block.url, sessionVars);
      const payload = JSON.parse(substituteVariables(JSON.stringify(block.body || {}), sessionVars));
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
    } else if (block.type === 'script') {
      const sandbox = { vars: sessionVars, output: '' };
      const code = `${block.code}\noutput = ${block.function};`;
      vm.createContext(sandbox);
      vm.runInContext(code, sandbox);
      content = sandbox.output?.toString() || '';
      if (block.outputVar) sessionVars[block.outputVar] = sandbox.output;
    }

    // 4.4) Envia mensagem se houver conteúdo
    if (
      content &&
      ['text','image','audio','video','file','document','location','interactive'].includes(block.type)
    ) {
      await markAsReadIfNeeded(message);
      if (block.sendDelayInSeconds) {
        await new Promise(r => setTimeout(r, block.sendDelayInSeconds * 1000));
      }
      try {
        await sendMessageByChannel(sessionVars.channel || 'whatsapp', userId, block.type, content);
      } catch (mediaErr) {
        console.error('❌ Falha ao enviar mídia:', mediaErr);
        const fallback = (typeof content === 'object' && content.url)
          ? `Aqui está seu conteúdo: ${content.url}`
          : `Aqui está sua mensagem: ${content}`;
        await sendMessageByChannel(sessionVars.channel || 'whatsapp', userId, 'text', fallback);
      }
      lastResponse = content;
    }

    // 4.5) Determina próximo bloco (incluindo onerror => previousBlock)
    let nextBlock = determineNextBlock(block, sessionVars, flow, currentBlockId);

    let resolvedBlock = block.awaitResponse ? currentBlockId : nextBlock;
    if (typeof resolvedBlock === 'string' && resolvedBlock.includes('{')) {
      resolvedBlock = substituteVariables(resolvedBlock, sessionVars);
    }
    if (!flow.blocks[resolvedBlock]) {
      resolvedBlock = 'onerror';
    }

    // 4.6) Atualiza previousBlock para evitar looping
    if (
      currentBlockId !== 'onerror' &&
      resolvedBlock !== 'onerror' &&
      (!sessionVars.previousBlock || sessionVars.previousBlock !== resolvedBlock)
    ) {
      sessionVars.previousBlock = currentBlockId;
    }

    // 4.7) Salva sessão com novo current_block e vars
    await saveSession(userId, resolvedBlock, flow.id, sessionVars);

    // 4.8) Interrompe se o bloco aguarda resposta
    if (block.awaitResponse) break;

    // 4.9) Delay de saída, se configurado
    const delay = parseInt(block.awaitTimeInSeconds || '0', 10);
    if (delay > 0) await new Promise(r => setTimeout(r, delay * 1000));

    // 4.10) Avança para o próximo bloco
    currentBlockId = resolvedBlock;
  }

  return lastResponse;
}
