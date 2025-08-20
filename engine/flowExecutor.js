// engine/flowExecutor.js
import axios from 'axios';
import vm from 'vm';

import { substituteVariables } from '../utils/vars.js';
import { evaluateConditions, determineNextBlock } from './utils.js';
import { loadSession, saveSession } from './sessionManager.js';
import { sendMessageByChannel } from './messenger.js';
import { distribuirTicket } from './ticketManager.js';
import { CHANNELS } from './messageTypes.js';

// Resolve o ID do bloco onError tanto por chave especial quanto por label
function resolveOnErrorId(flow) {
  if (flow?.blocks?.onerror) return 'onerror';
  const entry = Object.entries(flow?.blocks || {}).find(
    ([, b]) => (b?.label || '').toLowerCase() === 'onerror'
  );
  return entry ? entry[0] : null;
}

/**
 * Executa um fluxo JSON de atendimento. Sempre envia mensagens via fila (worker-outgoing).
 * - Se a sessão estiver em humano: não automatiza; apenas garante distribuição do ticket.
 *   (EXTRA: se o worker já marcou handover.status === 'closed', retoma pelas actions do bloco human.)
 * - Se o bloco atual for "human": salva estado, distribui e interrompe o fluxo.
 * - Para blocos que aguardam resposta (awaitResponse): interrompe o loop até próxima mensagem do usuário.
 */
export async function runFlow({ message, flow, vars, rawUserId, io }) {
  const userId = `${rawUserId}@w.msgcli.net`;

  // 0) Sanidade do fluxo
  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  // ✅ descobrir o onError logo no início
  const onErrorId = resolveOnErrorId(flow);

  // 1) Carrega (ou inicializa) sessão e vars
  const session = await loadSession(userId);
  let sessionVars = { ...(vars || {}), ...(session?.vars || {}) };

  if (!sessionVars.channel) sessionVars.channel = CHANNELS.WHATSAPP;

  let currentBlockId = null;

  // 2) Sessão em HUMANO
  if (session?.current_block === 'human') {
    const sVars = { ...(session?.vars || {}) };

    if (sVars?.handover?.status === 'closed') {
      const originId = sVars?.handover?.originBlock;
      const originBlock = originId ? flow.blocks[originId] : null;

      let nextFromHuman = null;
      if (originBlock) {
        nextFromHuman = determineNextBlock(originBlock, sVars, flow, originId);
      }

      // Fallbacks
      if (!nextFromHuman || !flow.blocks[nextFromHuman]) {
        if (flow.blocks?.onhumanreturn) nextFromHuman = 'onhumanreturn';
        else if (onErrorId)           nextFromHuman = onErrorId;
        else                          nextFromHuman = flow.start;
      }

      sessionVars = { ...(vars || {}), ...sVars };
      currentBlockId = nextFromHuman;
    } else {
      try {
        await distribuirTicket(rawUserId, sVars.fila, sVars.channel);
      } catch (e) {
        console.error('[flowExecutor] Falha ao distribuir ticket (sessão humana):', e);
      }
      return null;
    }
  }

  // 3) Determina bloco inicial (retomada ou start)
  if (currentBlockId == null) {
    if (session?.current_block && flow.blocks[session.current_block]) {
      const storedBlock = session.current_block;

      if (storedBlock === 'despedida') {
        currentBlockId = flow.start;
        sessionVars = { ...sessionVars };
        sessionVars.lastUserMessage = message;
      } else {
        const awaiting = flow.blocks[storedBlock];

        if (awaiting.actions && awaiting.actions.length > 0) {
          if (!message) return null; // aguardando resposta
          sessionVars.lastUserMessage = message;

          let next = null;
          for (const action of awaiting.actions || []) {
            if (evaluateConditions(action.conditions, sessionVars)) {
              next = action.next;
              break;
            }
          }
          if (!next && awaiting.defaultNext && flow.blocks[awaiting.defaultNext]) {
            next = awaiting.defaultNext;
          }
          if (!next && onErrorId) next = onErrorId;

          currentBlockId = next || storedBlock;
        } else {
          currentBlockId = storedBlock;
        }
      }
    } else {
      currentBlockId = flow.start;
      sessionVars.lastUserMessage = message;
    }
  }

  let lastResponse = null;

  // 4) Loop principal
  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    // 4.1) Bloco humano
    if (block.type === 'human') {
      if (block.content?.queueName) {
        sessionVars.fila = block.content.queueName;
        console.log(`[🧭 Fila capturada do bloco: "${sessionVars.fila}"]`);
      }

      sessionVars.handover = {
        ...(sessionVars.handover || {}),
        status: 'open',
        originBlock: currentBlockId
      };
      sessionVars.previousBlock = currentBlockId;

      await saveSession(userId, 'human', flow.id, sessionVars);

      try {
        await distribuirTicket(rawUserId, sessionVars.fila, sessionVars.channel);
      } catch (e) {
        console.error('[flowExecutor] Falha ao distribuir ticket (bloco human):', e);
      }

      return null;
    }

    // 4.2) Monta conteúdo
    let content = '';
    if (block.content != null) {
      try {
        content = typeof block.content === 'string'
          ? substituteVariables(block.content, sessionVars)
          : JSON.parse(substituteVariables(JSON.stringify(block.content), sessionVars));
      } catch (e) {
        console.error('[flowExecutor] Erro ao montar conteúdo do bloco:', e);
        content = '';
      }
    }

    // 4.3) API / Script
    try {
      if (block.type === 'api_call') {
        const url = substituteVariables(block.url, sessionVars);
        const payload = block.body
          ? JSON.parse(substituteVariables(JSON.stringify(block.body), sessionVars))
          : undefined;

        const res = await axios({
          method: (block.method || 'GET').toUpperCase(),
          url,
          data: payload
        });

        sessionVars.responseStatus = res.status;
        sessionVars.responseData = res.data;

        if (block.script) {
          const sandbox = { response: res.data, vars: sessionVars, output: '' };
          vm.createContext(sandbox);
          vm.runInContext(block.script, sandbox);
          content = sandbox.output;
        } else {
          content = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        }

        if (block.outputVar) sessionVars[block.outputVar] = content;
        if (block.statusVar) sessionVars[block.statusVar] = res.status;

      } else if (block.type === 'script') {
        const sandbox = { vars: sessionVars, output: '', console };
        const code = `
          ${block.code}
          try { output = ${block.function}; } catch (e) { output = ''; }
        `;
        vm.createContext(sandbox);
        vm.runInContext(code, sandbox);
        content = sandbox.output?.toString?.() ?? String(sandbox.output ?? '');

        if (block.outputVar) sessionVars[block.outputVar] = sandbox.output;
      }
    } catch (e) {
      console.error('[flowExecutor] Erro executando api_call/script:', e);
    }

    // 4.4) Envio da mensagem
    const sendableTypes = [
      'text', 'image', 'audio', 'video', 'file', 'document', 'location', 'interactive'
    ];

    if (content && sendableTypes.includes(block.type)) {
      if (block.sendDelayInSeconds) {
        const ms = Number(block.sendDelayInSeconds) * 1000;
        if (!Number.isNaN(ms) && ms > 0) {
          await new Promise(r => setTimeout(r, ms));
        }
      }

      try {
        const messageContent = (typeof content === 'string') ? { text: content } : content;

        const pendingRecord = await sendMessageByChannel(
          sessionVars.channel || CHANNELS.WHATSAPP,
          userId,
          block.type,
          messageContent
        );

        lastResponse = pendingRecord;

        if (io && pendingRecord) {
          try { io.emit('new_message', pendingRecord); } catch {}
          try { io.to(`chat-${userId}`).emit('new_message', pendingRecord); } catch {}
        }
      } catch (mediaErr) {
        console.error('❌ Falha ao enviar mídia (será enviado fallback):', mediaErr);

        const fallback =
          (typeof content === 'object' && content?.url)
            ? `Aqui está seu conteúdo: ${content.url}`
            : (typeof content === 'string'
                ? content
                : 'Não foi possível enviar o conteúdo solicitado.');

        try {
          const pendingFallback = await sendMessageByChannel(
            sessionVars.channel || CHANNELS.WHATSAPP,
            userId,
            'text',
            { text: fallback }
          );

          lastResponse = pendingFallback;

          if (io && pendingFallback) {
            try { io.emit('new_message', pendingFallback); } catch {}
            try { io.to(`chat-${userId}`).emit('new_message', pendingFallback); } catch {}
          }
        } catch (fallbackErr) {
          console.error('❌ Falha ao enviar fallback de texto:', fallbackErr);
        }
      }
    }

    // 4.5) Decide próximo bloco
    let nextBlock;
    if (currentBlockId === onErrorId) {
      // Voltando do erro: tenta voltar para o anterior; se não houver, vai para o start
      const back = sessionVars.previousBlock;
      nextBlock = (back && flow.blocks[back]) ? back : flow.start;
    } else {
      nextBlock = determineNextBlock(block, sessionVars, flow, currentBlockId);
    }

    let resolvedBlock = block.awaitResponse ? currentBlockId : nextBlock;

    // Placeholders (ex: {previousBlock})
    if (typeof resolvedBlock === 'string' && resolvedBlock.includes('{')) {
      resolvedBlock = substituteVariables(resolvedBlock, sessionVars);
    }

    // Se não existir no fluxo, cai para onError
    if (resolvedBlock && !flow.blocks[resolvedBlock]) {
      resolvedBlock = onErrorId || null;
    }

    // 🔒 Pausar se redirecionar para o START (somente quando vindo de outro bloco)
    const redirectingToStart =
      resolvedBlock === flow.start && currentBlockId !== flow.start;

    if (redirectingToStart) {
      await saveSession(userId, flow.start, flow.id, sessionVars);
      break; // pausa até nova mensagem do usuário
    }

    // 4.6) Atualiza previousBlock (não sobrescrever quando estamos no onError)
    if (
      currentBlockId !== onErrorId &&
      resolvedBlock &&
      resolvedBlock !== onErrorId
    ) {
      sessionVars.previousBlock = currentBlockId;
    }

    // 4.7) Persiste sessão com o bloco resolvido
    await saveSession(userId, resolvedBlock, flow.id, sessionVars);

    // 4.8) Se o bloco aguarda resposta do usuário, interrompe o loop
    if (block.awaitResponse) break;

    // 4.9) Delay pós-bloco
    if (
      block.awaitTimeInSeconds != null &&
      block.awaitTimeInSeconds !== false &&
      !isNaN(Number(block.awaitTimeInSeconds)) &&
      Number(block.awaitTimeInSeconds) > 0
    ) {
      await new Promise(r => setTimeout(r, Number(block.awaitTimeInSeconds) * 1000));
    }

    // 4.10) Avança
    currentBlockId = resolvedBlock;
  }

  return lastResponse;
}
