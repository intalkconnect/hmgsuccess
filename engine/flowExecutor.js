// engine/flowExecutor.js
import axios from 'axios';
import vm from 'vm';

import { substituteVariables } from '../utils/vars.js';
import { evaluateConditions } from './utils.js';
import { loadSession, saveSession } from './sessionManager.js';
import { sendMessageByChannel } from './messenger.js';
import { distribuirTicket } from './ticketManager.js';
import { CHANNELS } from './messageTypes.js';

import { isOpenNow } from './businessHours.js';
import { loadQueueBH } from './queueHoursService.js';

/* --------------------------- helpers --------------------------- */

function resolveOnErrorId(flow) {
  if (flow?.blocks?.onerror) return 'onerror';
  const entry = Object.entries(flow?.blocks || {}).find(
    ([, b]) => (b?.label || '').toLowerCase() === 'onerror'
  );
  return entry ? entry[0] : null;
}

function parseInboundMessage(msg) {
  const out = { text: null, id: null, title: null, type: null };

  try {
    // Meta WhatsApp Business API (webhook oficial)
    if (msg?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const message = msg.entry[0].changes[0].value.messages[0];
      return parseWhatsAppMessage(message);
    }

    // Outras libs que já extraem "messages"
    if (msg?.messages?.[0]) {
      return parseWhatsAppMessage(msg.messages[0]);
    }

    // Mensagem direta (tests)
    if (typeof msg === 'string') {
      out.text = msg.trim();
      out.type = 'text';
      return out;
    }

    // Estrutura alternativa
    if (msg?.message) {
      return parseWhatsAppMessage(msg.message);
    }

    return parseWhatsAppMessage(msg);

  } catch (error) {
    console.error('Error parsing message:', error);
    return out;
  }
}

function parseWhatsAppMessage(message) {
  const out = { text: null, id: null, title: null, type: null };

  if (!message) return out;

  out.type = message.type || 'text';

  switch (message.type) {
    case 'text':
      out.text = message.text?.body?.trim() || '';
      break;

    case 'interactive':
      if (message.interactive?.button_reply) {
        out.id = message.interactive.button_reply.id;
        out.title = message.interactive.button_reply.title;
        out.text = message.interactive.button_reply.title; // compat
      } else if (message.interactive?.list_reply) {
        out.id = message.interactive.list_reply.id;
        out.title = message.interactive.list_reply.title;
        out.text = message.interactive.list_reply.title; // compat
      }
      break;

    case 'button':
      out.id = message.button?.payload;
      out.title = message.button?.text;
      out.text = message.button?.text; // compat
      break;

    default:
      if (message.text?.body) {
        out.text = message.text.body.trim();
      } else if (message.body) {
        out.text = message.body.trim();
      }
  }

  return out;
}

function normalizeStr(v) {
  if (v == null) return '';
  let s = String(v);
  try { s = s.normalize('NFD').replace(/\p{Diacritic}/gu, ''); } catch {}
  return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Constrói mapa id<->title do bloco interativo atual (list ou button).
 * Usado para preencher/validar respostas, sem alterar o flow.
 */
function buildInteractiveAliases(block) {
  const out = { id2title: {}, title2id: {} };
  const c = block?.content;
  if (!c) return out;

  // List menu
  if (c.type === 'list') {
    for (const section of c.action?.sections || []) {
      for (const row of section.rows || []) {
        if (!row?.id || !row?.title) continue;
        out.id2title[row.id] = row.title;
        out.title2id[normalizeStr(row.title)] = row.id;
      }
    }
  }

  // Button menu
  if (c.type === 'button') {
    for (const b of c.action?.buttons || []) {
      const id = b?.reply?.id;
      const title = b?.reply?.title;
      if (!id || !title) continue;
      out.id2title[id] = title;
      out.title2id[normalizeStr(title)] = id;
    }
  }

  return out;
}

/**
 * Avaliação inteligente de condições:
 * - Tenta direto com vars.
 * - Se falhar, tenta com lastReplyId e lastReplyTitle como lastUserMessage.
 * - Se ainda falhar, constrói um pool de candidatos (id/title/alias normalizados)
 *   e reavalia contra cada candidato.
 */
function evalConditionsSmart(conditions = [], vars = {}) {
  if (evaluateConditions(conditions, vars)) return true;

  if (vars.lastReplyId) {
    const v2 = { ...vars, lastUserMessage: vars.lastReplyId };
    if (evaluateConditions(conditions, v2)) return true;
  }
  if (vars.lastReplyTitle) {
    const v3 = { ...vars, lastUserMessage: vars.lastReplyTitle };
    if (evaluateConditions(conditions, v3)) return true;
  }

  // Normalização básica
  const vNorm = {
    ...vars,
    lastUserMessage: normalizeStr(vars.lastUserMessage),
    lastReplyId: normalizeStr(vars.lastReplyId),
    lastReplyTitle: normalizeStr(vars.lastReplyTitle),
  };
  const cNorm = (conditions || []).map((c) => {
    if (!c) return c;
    const type = c.type?.toLowerCase?.();
    if (['equals','not_equals','contains','starts_with','ends_with'].includes(type)) {
      return { ...c, value: normalizeStr(c.value) };
    }
    return c;
  });
  if (evaluateConditions(cNorm, vNorm)) return true;

  // Pool de candidatos (id/title e aliases)
  const poolRaw = Array.isArray(vars._candidates) ? vars._candidates : [];
  const pool = Array.from(new Set(
    [
      vars.lastUserMessage,
      vars.lastReplyTitle,
      vars.lastReplyId,
      ...poolRaw
    ].filter(Boolean).map(normalizeStr)
  ));

  if (pool.length) {
    for (const candidate of pool) {
      const v = {
        ...vars,
        lastUserMessage: candidate,
        lastReplyId: normalizeStr(vars.lastReplyId),
        lastReplyTitle: normalizeStr(vars.lastReplyTitle),
      };
      if (evaluateConditions(cNorm, v)) return true;
    }
  }

  return false;
}

function determineNextSmart(block, vars, flow, currentId) {
  for (const action of block?.actions || []) {
    if (evalConditionsSmart(action.conditions || [], vars)) {
      return action.next;
    }
  }
  if (block?.defaultNext && flow.blocks[block.defaultNext]) {
    return block.defaultNext;
  }
  return null;
}

async function sendConfiguredMessage(entry, { channel, userId, io }) {
  if (!entry) return null;
  if (entry.delayMs) {
    const ms = Number(entry.delayMs);
    if (!Number.isNaN(ms) && ms > 0) await new Promise(r => setTimeout(r, ms));
  }
  const type = entry.type || 'text';
  const content =
    typeof entry.message === 'string'
      ? { text: entry.message }
      : (entry.payload || entry.content || null);
  if (!content) return null;

  try {
    const rec = await sendMessageByChannel(channel, userId, type, content);
    if (io && rec) {
      try { io.emit('new_message', rec); } catch {}
      try { io.to(`chat-${userId}`).emit('new_message', rec); } catch {}
    }
    return rec;
  } catch (e) {
    console.error('[flowExecutor] sendConfiguredMessage error:', e);
    return null;
  }
}

function resolveByIdOrLabel(flow, key) {
  if (!key) return null;
  if (flow.blocks[key]) return key;
  const found = Object.entries(flow.blocks).find(([, b]) => (b?.label || '') === key);
  return found ? found[0] : null;
}

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
      try { await distribuirTicket(rawUserId, sVars.fila, sVars.channel); } catch (e) {
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

          // Atualiza variáveis com a mensagem recebida (sem 'init' fake)
          const hasInbound =
            !!(inbound && (inbound.title || inbound.text || inbound.id));
          sessionVars.lastUserMessage = hasInbound
            ? (inbound.title ?? inbound.text ?? inbound.id ?? '')
            : (sessionVars.lastUserMessage ?? '');
          sessionVars.lastReplyId = hasInbound ? (inbound.id ?? null) : (sessionVars.lastReplyId ?? null);
          sessionVars.lastReplyTitle = hasInbound ? (inbound.title ?? null) : (sessionVars.lastReplyTitle ?? null);
          sessionVars.lastMessageType = hasInbound ? inbound.type : (sessionVars.lastMessageType ?? 'init');

          // Se o bloco aguardando é interativo, construir aliases e pool
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

            // Pool de candidatos
            sessionVars._candidates = Array.from(new Set([
              sessionVars.lastUserMessage,
              sessionVars.lastReplyTitle,
              sessionVars.lastReplyId,
              aliases.id2title[sessionVars.lastReplyId],
              aliases.title2id[normalizeStr(sessionVars.lastReplyTitle)]
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

      // Inicializa variáveis só se houver mensagem real do usuário
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

      // popula variáveis p/ condições no builder
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
            userId, io
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
            userId, io
          });
        } else if (block.content?.transferMessage) {
          await sendConfiguredMessage(
            { type: 'text', message: block.content.transferMessage },
            { channel: sessionVars.channel || CHANNELS.WHATSAPP, userId, io }
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
        await distribuirTicket(rawUserId, sessionVars.fila, sessionVars.channel);
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
