// engine/flowExecutor.js
import axios from 'axios';
import vm from 'vm';

import { substituteVariables } from '../utils/vars.js';
import { loadSession, saveSession } from './sessionManager.js';
import { distribuirTicket } from './ticketManager.js';
import { CHANNELS } from './messageTypes.js';
import { isOpenNow } from './businessHours.js';
import { loadQueueBH } from './queueHoursService.js';

// helpers centralizados
import {
  resolveOnErrorId,
  parseInboundMessage,
  buildInteractiveAliases,
  determineNextSmart,
  sendConfiguredMessage,
  resolveByIdOrLabel,
  buildProtocol,
} from './helpers.js';

/* --------------------------- executor --------------------------- */

export async function runFlow({ message, flow, vars, rawUserId, io }) {
  const userId = `${rawUserId}@w.msgcli.net`;

  console.log('🔍 RAW MESSAGE STRUCTURE:');
  console.dir(message, { depth: 5 });
  console.log('🔍 FLOW START:', flow.start);
  console.log('🔍 FLOW BLOCKS:', Object.keys(flow.blocks));

  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  const onErrorId = resolveOnErrorId(flow);

  const session = await loadSession(userId);
  let sessionVars = { ...(vars || {}), ...(session?.vars || {}) };
  if (!sessionVars.channel) sessionVars.channel = CHANNELS.WHATSAPP;

  // ✅ garante que exista um protocol logo de cara
  if (!sessionVars.protocol) {
    sessionVars.protocol = buildProtocol(sessionVars);
  }

  console.log('💾 Session loaded:', session);
  console.log('📊 Session vars:', sessionVars);

  let currentBlockId = null;

  // Parse inbound
  const inbound = parseInboundMessage(message);
  console.log('🧠 Parsed message:', inbound);

  // Se já está em humano
  if (session?.current_block === 'human') {
    console.log('🤖 Session is in human mode');
    const sVars = { ...(session?.vars || {}) };
    if (sVars?.handover?.status === 'closed') {
      console.log('🔙 Returning from human handover');
      const originId = sVars?.handover?.originBlock;
      const originBlock = originId ? flow.blocks[originId] : null;

      let nextFromHuman = originBlock
        ? determineNextSmart(originBlock, sVars, flow, originId)
        : null;

      if (!nextFromHuman || !flow.blocks[nextFromHuman]) {
        if (flow.blocks?.onhumanreturn) nextFromHuman = 'onhumanreturn';
        else if (onErrorId)           nextFromHuman = onErrorId;
        else                          nextFromHuman = flow.start;
      }

      sessionVars = { ...(vars || {}), ...sVars };
      currentBlockId = nextFromHuman;
    } else {
      console.log('📞 Distributing ticket for human session');
      try {
        const dist = await distribuirTicket(rawUserId, sVars.fila, sVars.channel);
        if (dist?.ticketNumber || dist?.ticketId || dist?.id) {
          const t = String(dist.ticketNumber || dist.ticketId || dist.id);
          sVars.ticketNumber = t;
          sVars.protocol = buildProtocol({ ...sVars, ticketNumber: t });
          await saveSession(userId, 'human', flow.id, sVars);
        }
      } catch (e) {
        console.error('[flowExecutor] Falha ao distribuir ticket (sessão humana):', e);
      }
      return null;
    }
  }

  // inicial / retomada
  if (currentBlockId == null) {
    console.log('🔄 Determining starting block');

    if (session?.current_block && flow.blocks[session.current_block]) {
      const stored = session.current_block;
      console.log('📦 Resuming from stored block:', stored);

      if (stored === 'despedida') {
        currentBlockId = flow.start;
        console.log('🔄 Restarting flow from start (despedida)');
      } else {
        const awaiting = flow.blocks[stored];
        console.log('⏳ Block awaiting response:', awaiting?.label);

        if (awaiting.actions && awaiting.actions.length > 0) {
          if (!message && stored !== flow.start) {
            console.log('🚫 No message, staying on current block');
            return null;
          }

          const hasInbound =
            !!(inbound && (inbound.title || inbound.text || inbound.id));
          sessionVars.lastUserMessage = hasInbound
            ? (inbound.title ?? inbound.text ?? inbound.id ?? '')
            : (sessionVars.lastUserMessage ?? '');
          sessionVars.lastReplyId = hasInbound ? (inbound.id ?? null) : (sessionVars.lastReplyId ?? null);
          sessionVars.lastReplyTitle = hasInbound ? (inbound.title ?? null) : (sessionVars.lastReplyTitle ?? null);
          sessionVars.lastMessageType = hasInbound ? inbound.type : (sessionVars.lastMessageType ?? 'init');

          if (awaiting?.type === 'interactive') {
            const aliases = buildInteractiveAliases(awaiting);

            if (sessionVars.lastReplyId && !sessionVars.lastReplyTitle) {
              sessionVars.lastReplyTitle =
                aliases.id2title[sessionVars.lastReplyId] || sessionVars.lastReplyTitle;
            }
            if (sessionVars.lastReplyTitle && !sessionVars.lastReplyId) {
              const id = aliases.title2id[normalizeStr(sessionVars.lastReplyTitle)];
              sessionVars.lastReplyId = id || sessionVars.lastReplyId;
            }

            sessionVars._candidates = Array.from(new Set([
              sessionVars.lastUserMessage,
              sessionVars.lastReplyTitle,
              sessionVars.lastReplyId,
              aliases.id2title[sessionVars.lastReplyId],
              aliases.title2id?.[normalizeStr(sessionVars.lastReplyTitle)]
            ].filter(Boolean)));
          }

          let next = determineNextSmart(awaiting, sessionVars, flow, stored);
          console.log('➡️ Next block from actions:', next);

          if (!next && onErrorId) next = onErrorId;
          currentBlockId = next || stored;
        } else {
          currentBlockId = stored;
        }
      }
    } else {
      // Nova sessão - começa do início
      currentBlockId = flow.start;
      console.log('🚀 Starting new session from flow start');

      const hasInbound =
        !!(inbound && (inbound.title || inbound.text || inbound.id));
      sessionVars.lastUserMessage = hasInbound
        ? (inbound.title ?? inbound.text ?? inbound.id)
        : '';
      sessionVars.lastReplyId = hasInbound ? (inbound.id ?? null) : null;
      sessionVars.lastReplyTitle = hasInbound ? (inbound.title ?? null) : null;
      sessionVars.lastMessageType = hasInbound ? inbound.type : 'init';
    }
  }

  console.log('🎯 Current block ID:', currentBlockId);

  let lastResponse = null;

  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) {
      console.error('❌ Block not found:', currentBlockId);
      break;
    }

    console.log('🏃‍♂️ Processing block:', block.label || block.id, 'type:', block.type);

    /* ---------- HUMAN + horários por fila ---------- */
    if (block.type === 'human') {
      console.log('👥 Human handover block detected');

      if (block.content?.queueName) {
        sessionVars.fila = block.content.queueName;
        console.log(`🧭 Queue set to: ${sessionVars.fila}`);
      }

      const bhCfg = await loadQueueBH(sessionVars.fila);
      const { open, reason } = bhCfg ? isOpenNow(bhCfg) : { open: true, reason: null };

      sessionVars.offhours = !open;
      sessionVars.offhours_reason = reason;
      sessionVars.isHoliday = reason === 'holiday';
      sessionVars.offhours_queue = sessionVars.fila || null;

      console.log('🕒 Business hours check - open:', open, 'reason:', reason);

      if (!open) {
        console.log('🚫 Outside business hours');

        const msgCfg =
          (reason === 'holiday' && bhCfg?.off_hours?.holiday) ? bhCfg.off_hours.holiday :
          (reason === 'closed'  && bhCfg?.off_hours?.closed ) ? bhCfg.off_hours.closed  :
          bhCfg?.off_hours || null;

        if (msgCfg) {
          console.log('📤 Sending off-hours message');
          await sendConfiguredMessage(msgCfg, {
            channel: sessionVars.channel || CHANNELS.WHATSAPP,
            userId, io, vars: sessionVars
          });
        }

        let cfgNext = null;
        if (reason === 'holiday') {
          cfgNext = msgCfg?.next ?? bhCfg?.off_hours?.nextHoliday ?? bhCfg?.off_hours?.next ?? null;
        } else {
          cfgNext = msgCfg?.next ?? bhCfg?.off_hours?.nextClosed  ?? bhCfg?.off_hours?.next ?? null;
        }

        let nextBlock = determineNextSmart(block, sessionVars, flow, currentBlockId);
        console.log('➡️ Next block from conditions:', nextBlock);

        if (!nextBlock && cfgNext) {
          nextBlock = resolveByIdOrLabel(flow, cfgNext);
          console.log('➡️ Next block from config:', nextBlock);
        }

        if (!nextBlock) nextBlock = flow.blocks?.offhours ? 'offhours' : resolveOnErrorId(flow);
        nextBlock = nextBlock || currentBlockId;

        console.log('💾 Saving session with next block:', nextBlock);
        await saveSession(userId, nextBlock, flow.id, sessionVars);
        currentBlockId = nextBlock;
        continue;
      }

      console.log('✅ Business hours - open, proceeding with handover');

      const preEnabled = bhCfg?.pre_human?.enabled !== false;
      const preAlreadySent = !!(sessionVars.handover?.preMsgSent);

      if (preEnabled && !preAlreadySent) {
        console.log('📤 Sending pre-human message');
        if (bhCfg?.pre_human) {
          await sendConfiguredMessage(bhCfg.pre_human, {
            channel: sessionVars.channel || CHANNELS.WHATSAPP,
            userId, io, vars: sessionVars
          });
        } else if (block.content?.transferMessage) {
          await sendConfiguredMessage(
            { type: 'text', message: block.content.transferMessage },
            { channel: sessionVars.channel || CHANNELS.WHATSAPP, userId, io, vars: sessionVars }
          );
        }
      }

      sessionVars.handover = {
        ...(sessionVars.handover || {}),
        status: 'open',
        originBlock: currentBlockId,
        preMsgSent: true
      };
      sessionVars.previousBlock = currentBlockId;
      sessionVars.offhours = false;
      sessionVars.offhours_reason = null;
      sessionVars.isHoliday = false;

      console.log('💾 Saving human session');
      await saveSession(userId, 'human', flow.id, sessionVars);

      try {
        const dist = await distribuirTicket(rawUserId, sessionVars.fila, sessionVars.channel);
        if (dist?.ticketNumber || dist?.ticketId || dist?.id) {
          const t = String(dist.ticketNumber || dist.ticketId || dist.id);
          sessionVars.ticketNumber = t;
          sessionVars.protocol = buildProtocol({ ...sessionVars, ticketNumber: t });
          await saveSession(userId, 'human', flow.id, sessionVars);
        }
        console.log('✅ Ticket distributed successfully');
      } catch (e) {
        console.error('[flowExecutor] Falha ao distribuir ticket (human):', e);
      }
      return null;
    }

    /* ---------- Conteúdo / API / Script ---------- */
    let content = '';
    if (block.content != null) {
      try {
        // garante que protocol sempre esteja atualizado (caso ticketNumber tenha surgido em bloco anterior)
        if (sessionVars.ticketNumber) {
          const nextProt = buildProtocol(sessionVars);
          if (sessionVars.protocol !== nextProt) sessionVars.protocol = nextProt;
        }

        content = typeof block.content === 'string'
          ? substituteVariables(block.content, sessionVars)
          : JSON.parse(substituteVariables(JSON.stringify(block.content), sessionVars));
        console.log('📝 Block content processed:', typeof content === 'string' ? content.substring(0, 100) + '...' : '[object]');
      } catch (e) {
        console.error('[flowExecutor] Erro ao montar conteúdo do bloco:', e);
        content = '';
      }
    }

    try {
      if (block.type === 'api_call') {
        console.log('🌐 API call block');
        const url = substituteVariables(block.url, sessionVars);
        const payload = block.body
          ? JSON.parse(substituteVariables(JSON.stringify(block.body), sessionVars))
          : undefined;

        console.log('📡 API call to:', url);
        const res = await axios({
          method: (block.method || 'GET').toUpperCase(),
          url, data: payload
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
        console.log('📜 Script block');
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

    /* ---------- Envio ---------- */
    const sendableTypes = ['text','image','audio','video','file','document','location','interactive'];

    if (content && sendableTypes.includes(block.type)) {
      console.log('📤 Sending message of type:', block.type);

      if (block.sendDelayInSeconds) {
        const ms = Number(block.sendDelayInSeconds) * 1000;
        if (!Number.isNaN(ms) && ms > 0) {
          console.log('⏳ Delaying send by', ms, 'ms');
          await new Promise(r => setTimeout(r, ms));
        }
      }

      try {
        const messageContent = (typeof content === 'string') ? { text: content } : content;
        const pendingRecord = await sendMessageByChannel(
          sessionVars.channel || CHANNELS.WHATSAPP,
          userId, block.type, messageContent
        );
        lastResponse = pendingRecord;
        console.log('✅ Message sent successfully');

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
            userId, 'text', { text: fallback }
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

    /* ---------- Próximo ---------- */
    let nextBlock;
    if (currentBlockId === onErrorId) {
      console.log('🔄 Returning from error block');
      const back = sessionVars.previousBlock;
      nextBlock = (back && flow.blocks[back]) ? back : flow.start;
    } else {
      nextBlock = determineNextSmart(block, sessionVars, flow, currentBlockId);
      console.log('➡️ Next block determined:', nextBlock);
    }

    let resolvedBlock = block.awaitResponse ? currentBlockId : nextBlock;
    console.log('⏸️ Block awaits response:', block.awaitResponse, 'Resolved block:', resolvedBlock);

    if (typeof resolvedBlock === 'string' && resolvedBlock.includes('{')) {
      resolvedBlock = substituteVariables(resolvedBlock, sessionVars);
      console.log('🔧 Resolved dynamic block:', resolvedBlock);
    }

    if (resolvedBlock && !flow.blocks[resolvedBlock]) {
      console.log('❌ Resolved block not found, using onError');
      resolvedBlock = onErrorId || null;
    }

    const redirectingToStart =
      resolvedBlock === flow.start && currentBlockId !== flow.start;
    if (redirectingToStart) {
      console.log('🔄 Redirecting to flow start');
      await saveSession(userId, flow.start, flow.id, sessionVars);
      break;
    }

    if (currentBlockId !== onErrorId && resolvedBlock && resolvedBlock !== onErrorId) {
      sessionVars.previousBlock = currentBlockId;
    }

    console.log('💾 Saving session with block:', resolvedBlock);
    await saveSession(userId, resolvedBlock, flow.id, sessionVars);

    if (block.awaitResponse) {
      console.log('⏸️ Awaiting response, breaking loop');
      break;
    }

    if (
      block.awaitTimeInSeconds != null &&
      block.awaitTimeInSeconds !== false &&
      !isNaN(Number(block.awaitTimeInSeconds)) &&
      Number(block.awaitTimeInSeconds) > 0
    ) {
      const delay = Number(block.awaitTimeInSeconds) * 1000;
      console.log('⏳ Awaiting time:', delay, 'ms');
      await new Promise(r => setTimeout(r, delay));
    }

    currentBlockId = resolvedBlock;
    console.log('🔄 Moving to next block:', currentBlockId);
  }

  console.log('🏁 Flow execution completed');
  return lastResponse;
}
