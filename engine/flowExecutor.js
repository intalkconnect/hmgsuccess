// engine/flowExecutor.js

import axios from 'axios';
import vm from 'vm';

import { substituteVariables } from '../utils/vars.js';
import { evaluateConditions, determineNextBlock } from './utils.js';
import { loadSession, saveSession } from './sessionManager.js';
import { sendMessageByChannel } from './messenger.js';
import { distribuirTicket } from './ticketManager.js';
import { CHANNELS } from './messageTypes.js';

/**
 * Executa um fluxo JSON de atendimento. Sempre envia mensagens via fila (worker-outgoing).
 * - Se a sessão estiver em humano: não automatiza; apenas garante distribuição do ticket.
 *   (EXTRA: se o worker já marcou handover.status === 'closed', retoma pelas actions do bloco human.)
 * - Se o bloco atual for "human": salva estado, distribui e interrompe o fluxo.
 * - Para blocos que aguardam resposta (awaitResponse): interrompe o loop até próxima mensagem do usuário.
 */
export async function runFlow({ message, flow, vars, rawUserId, io }) {
  // userId interno (padrão WhatsApp). O messenger normaliza "to" por canal.
  const userId = `${rawUserId}@w.msgcli.net`;

  // 0) Sanidade do fluxo
  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  // 1) Carrega (ou inicializa) sessão e vars
  const session = await loadSession(userId);
  let sessionVars = { ...(vars || {}), ...(session?.vars || {}) };

  // canal default
  if (!sessionVars.channel) sessionVars.channel = CHANNELS.WHATSAPP;

  let currentBlockId = null;

  // 2) Se já estiver em atendimento humano, garante distribuição OU retoma se já foi fechado (ADICIONADO)
  if (session?.current_block === 'human') {
    const sVars = { ...(session?.vars || {}) };

    // 👉 Caso o worker já tenha marcado fechamento (evento de "finalizar"):
    //    - sVars.handover.status === 'closed'
    //    - sVars.ticket.number já contém o número final do ticket (gravado pelo worker)
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
        else if (flow.blocks?.onerror)  nextFromHuman = 'onerror';
        else                            nextFromHuman = flow.start;
      }

      // Preserva todas as variáveis que o worker já gravou (inclui ticket.number)
      sessionVars = { ...(vars || {}), ...sVars };
      currentBlockId = nextFromHuman; // segue o fluxo a partir daqui
    } else {
      // atendimento ainda em humano → só redistribui e sai
      try {
        await distribuirTicket(rawUserId, sVars.fila, sVars.channel);
      } catch (e) {
        console.error('[flowExecutor] Falha ao distribuir ticket (sessão humana):', e);
      }
      return null;
    }
  }

  // 3) Determina bloco inicial (retomada ou start) — apenas se ainda não decidimos acima (ADICIONADO o guard)
  if (currentBlockId == null) {
    if (session?.current_block && flow.blocks[session.current_block]) {
      const storedBlock = session.current_block;

      // Se o último bloco foi uma "despedida", reinicia do start
      if (storedBlock === 'despedida') {
        currentBlockId = flow.start;
        sessionVars = { ...sessionVars };
        sessionVars.lastUserMessage = message;
      } else {
        const awaiting = flow.blocks[storedBlock];

        if (awaiting.actions && awaiting.actions.length > 0) {
          // Esse bloco estava aguardando resposta do usuário
          if (!message) return null; // ainda aguardando
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
          if (!next && flow.blocks.onerror) next = 'onerror';

          currentBlockId = next || storedBlock; // fallback de segurança
        } else {
          // O bloco anterior não aguardava resposta; continua dele
          currentBlockId = storedBlock;
        }
      }
    } else {
      // Sem sessão existente: inicia no "start"
      currentBlockId = flow.start;
      sessionVars.lastUserMessage = message;
    }
  }

  let lastResponse = null;

  // 4) Loop principal do fluxo
  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    // 4.1) Se o bloco for "human": salva estado, distribui ticket e interrompe
    if (block.type === 'human') {
      // Captura queueName do bloco (se houver)
      if (block.content?.queueName) {
        sessionVars.fila = block.content.queueName;
        console.log(`[🧭 Fila capturada do bloco: "${sessionVars.fila}"]`);
      }

      // (ADICIONADO) memoriza a origem e marca handover aberto — usado para retomar após fechamento
      sessionVars.handover = {
        ...(sessionVars.handover || {}),
        status: 'open',
        originBlock: currentBlockId
      };
      sessionVars.previousBlock = currentBlockId;

      // Persiste sessão como HUMANO
      await saveSession(userId, 'human', flow.id, sessionVars);

      // Distribui para atendimento humano
      try {
        await distribuirTicket(rawUserId, sessionVars.fila, sessionVars.channel);
      } catch (e) {
        console.error('[flowExecutor] Falha ao distribuir ticket (bloco human):', e);
      }

      return null; // interrompe automação aqui
    }

    // 4.2) Prepara conteúdo do bloco (com substituição de variáveis)
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

    // 4.3) Execução de API/SCRIPT que alimentam o conteúdo e variáveis
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
      // mantém content vazio; next resolverá para onerror se configurado
    }

    // 4.4) Envio de mensagem (passa sempre pelo worker-outgoing)
    const sendableTypes = [
      'text', 'image', 'audio', 'video', 'file', 'document', 'location', 'interactive'
    ];

    if (content && sendableTypes.includes(block.type)) {
      // Delay antes do envio, se configurado
      if (block.sendDelayInSeconds) {
        const ms = Number(block.sendDelayInSeconds) * 1000;
        if (!Number.isNaN(ms) && ms > 0) {
          await new Promise(r => setTimeout(r, ms));
        }
      }

      try {
        // Normaliza payload para texto simples quando vier string
        const messageContent = (typeof content === 'string')
          ? { text: content }
          : content;

        // Enfileira via messenger (que persiste "pending" e retorna o registro)
        const pendingRecord = await sendMessageByChannel(
          sessionVars.channel || CHANNELS.WHATSAPP,
          userId,
          block.type,
          messageContent
        );

        lastResponse = pendingRecord;

        // Emite para o front (socket global e sala do chat)
        if (io && pendingRecord) {
          try { io.emit('new_message', pendingRecord); } catch {}
          try { io.to(`chat-${userId}`).emit('new_message', pendingRecord); } catch {}
        }
      } catch (mediaErr) {
        console.error('❌ Falha ao enviar mídia (será enviado fallback):', mediaErr);

        // Fallback simples de texto com URL ou conteúdo
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
    let nextBlock = determineNextBlock(block, sessionVars, flow, currentBlockId);
    let resolvedBlock = block.awaitResponse ? currentBlockId : nextBlock;

    // Substitui placeholders (ex: {previousBlock})
    if (typeof resolvedBlock === 'string' && resolvedBlock.includes('{')) {
      resolvedBlock = substituteVariables(resolvedBlock, sessionVars);
    }

    // Se não existir no fluxo, vai para onerror (se houver)
    if (!flow.blocks[resolvedBlock]) {
      resolvedBlock = flow.blocks.onerror ? 'onerror' : null;
    }

    // 4.6) Atualiza previousBlock (anti-loop simples)
    if (
      currentBlockId !== 'onerror' &&
      resolvedBlock &&
      resolvedBlock !== 'onerror'
    ) {
      sessionVars.previousBlock = currentBlockId;
    }

    // 4.7) Persiste sessão com o bloco resolvido
    await saveSession(userId, resolvedBlock, flow.id, sessionVars);

    // 4.8) Se o bloco aguarda resposta do usuário, interrompe o loop
    if (block.awaitResponse) break;

    // 4.9) Delay pós-bloco, se configurado
    if (
      block.awaitTimeInSeconds != null &&
      block.awaitTimeInSeconds !== false &&
      !isNaN(Number(block.awaitTimeInSeconds)) &&
      Number(block.awaitTimeInSeconds) > 0
    ) {
      await new Promise(r => setTimeout(r, Number(block.awaitTimeInSeconds) * 1000));
    }

    // 4.10) Avança para o próximo bloco
    currentBlockId = resolvedBlock;
  }

  return lastResponse;
}
