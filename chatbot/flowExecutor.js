// engine/flowExecutor.js

import { substituteVariables } from '../utils/vars.js';
import axios from 'axios';
import vm from 'vm';
import { evaluateConditions, determineNextBlock } from './utils.js';
import { loadSession, saveSession } from './sessionManager.js';
import { sendMessageByChannel, markAsReadIfNeeded } from './messenger.js';
import { logOutgoingMessage, logOutgoingFallback } from './messageLogger.js';

export async function runFlow({ message, flow, vars, rawUserId }) {
  const userId = `${rawUserId}@w.msgcli.net`;

  // Se não houver fluxo válido, retorna mensagem de erro
  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  // 1) Carrega (ou inicializa) a sessão do usuário
  const session = await loadSession(userId);
  let sessionVars = { ...vars, ...(session.vars || {}) };
  let currentBlockId = null;

  // 2) Se já estiver em atendimento humano, salva e interrompe
  if (session.current_block === 'atendimento_humano') {
    await saveSession(userId, 'atendimento_humano', flow.id, session.vars || {});
    return null;
  }

  // 3) Determina qual bloco exibir agora (retoma sessão ou vai para start)
  if (session.current_block && flow.blocks[session.current_block]) {
    const storedBlock = session.current_block;

    // Se o bloco anterior foi “despedida”, reinicia o fluxo
    if (storedBlock === 'despedida') {
      currentBlockId = flow.start;
      sessionVars = {}; 
      sessionVars.lastUserMessage = message;
    } else {
      const awaiting = flow.blocks[storedBlock];
      if (awaiting.awaitResponse) {
        if (!message) return null;
        sessionVars.lastUserMessage = message;

        // Avalia as condições de saída do bloco anterior
        for (const action of awaiting.actions || []) {
          if (evaluateConditions(action.conditions, sessionVars)) {
            currentBlockId = action.next;
            break;
          }
        }
        // Se não encontrou nenhuma ação válida, tenta defaultNext
        if (!currentBlockId && awaiting.defaultNext && flow.blocks[awaiting.defaultNext]) {
          currentBlockId = awaiting.defaultNext;
        }
        // Se ainda indefinido, cai em onerror
        if (!currentBlockId && flow.blocks.onerror) {
          currentBlockId = 'onerror';
        }
      } else {
        // Se o bloco anterior não aguardava resposta, permanece nele
        currentBlockId = storedBlock;
      }
    }
  } else {
    // Sem sessão existente: inicia no bloco “start”
    currentBlockId = flow.start;
  }

  let lastResponse = null;

  // 4) Loop principal: para enquanto houver bloco a ser processado
  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    // 4.1) Se o tipo for “human”, salva e retorna (não envia mensagem de bot)
    if (block.type === 'human') {
      await saveSession(userId, 'atendimento_humano', flow.id, sessionVars);
      return null;
    }

    // 4.2) Prepara o conteúdo do bloco (texto ou JSON)
    let content = '';
    if (block.content != null) {
      content = typeof block.content === 'string'
        ? substituteVariables(block.content, sessionVars)
        : JSON.parse(substituteVariables(JSON.stringify(block.content), sessionVars));
    }

    // 4.3) Caso seja API call ou script, executa e define “content”
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

    // 4.4) Se existir conteúdo e for tipo válidos, envia ao usuário e registra “outgoing”
    if (
      content &&
      ['text','image','audio','video','file','document','location','interactive'].includes(block.type)
    ) {
      // Marca como lido, se houver
      await markAsReadIfNeeded(message);

      // Delay customizado
      if (block.sendDelayInSeconds) {
        await new Promise(r => setTimeout(r, block.sendDelayInSeconds * 1000));
      }

      // Tenta enviar e registrar
      try {
        // 4.4.1) Envia a mensagem ao usuário
        await sendMessageByChannel(
          sessionVars.channel || 'whatsapp',
          userId,
          block.type,
          content
        );

        // 4.4.2) Registra no banco como “outgoing”
        console.log('[flowExecutor] Gravando outgoing:', {
          userId, 
          type: block.type, 
          content,
          flowId: flow.id
        });
        const inserted = await logOutgoingMessage(userId, block.type, content, flow.id);
lastResponse = inserted;


      } catch (mediaErr) {
        console.error('❌ Falha ao enviar mídia:', mediaErr);
        const fallback = (typeof content === 'object' && content.url)
          ? `Aqui está seu conteúdo: ${content.url}`
          : `Aqui está sua mensagem: ${content}`;

        // 4.4.3) Envia fallback de texto simples
        await sendMessageByChannel(
          sessionVars.channel || 'whatsapp',
          userId,
          'text',
          fallback
        );

        // 4.4.4) Registra fallback como “outgoing”
        console.log('[flowExecutor] Gravando fallback outgoing:', {
          userId,
          content: fallback,
          flowId: flow.id
        });
        await logOutgoingFallback(userId, fallback, flow.id);
      }

      lastResponse = content;
    }

    // 4.5) Determina o bloco seguinte (lembra de {previousBlock} e onerror)
    let nextBlock = determineNextBlock(block, sessionVars, flow, currentBlockId);
    let resolvedBlock = block.awaitResponse ? currentBlockId : nextBlock;

    // Se houver placeholder “{previousBlock}”, substitui
    if (typeof resolvedBlock === 'string' && resolvedBlock.includes('{')) {
      resolvedBlock = substituteVariables(resolvedBlock, sessionVars);
    }
    // Se não existir no fluxo, cai em “onerror”
    if (!flow.blocks[resolvedBlock]) {
      resolvedBlock = 'onerror';
    }

    // 4.6) Atualiza previousBlock (para evitar loop infinito)
    if (
      currentBlockId !== 'onerror' &&
      resolvedBlock !== 'onerror' &&
      (!sessionVars.previousBlock || sessionVars.previousBlock !== resolvedBlock)
    ) {
      sessionVars.previousBlock = currentBlockId;
    }

    // 4.7) Persiste a sessão com o bloco resolvido
    await saveSession(userId, resolvedBlock, flow.id, sessionVars);

    // 4.8) Se o bloco aguarda resposta, interrompe o loop (espera próximo input)
    if (block.awaitResponse) break;

    // 4.9) Delay de saída, se configurado pelo bloco
    const delay = parseInt(block.awaitTimeInSeconds || '0', 10);
    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay * 1000));
    }

    // 4.10) Avança para o próximo bloco
    currentBlockId = resolvedBlock;
  }

  return lastResponse;
}
