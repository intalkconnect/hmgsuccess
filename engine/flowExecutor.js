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
    if (typeof msg === 'string') {
      out.text = msg.trim();
      out.type = 'text';
      return out;
    }
    if (!msg || typeof msg !== 'object') return out;
    const m = (msg.message || msg);
    out.type = m.type || msg.type || null;

    if (m.interactive?.button_reply) {
      out.id = m.interactive.button_reply.id ?? null;
      out.title = m.interactive.button_reply.title ?? null;
      out.type = 'interactive.button_reply';
      return out;
    }
    if (m.interactive?.list_reply) {
      out.id = m.interactive.list_reply.id ?? null;
      out.title = m.interactive.list_reply.title ?? null;
      out.type = 'interactive.list_reply';
      return out;
    }
    if (m.button?.payload || m.button?.text) {
      out.id = m.button.payload ?? null;
      out.title = m.button.text ?? null;
      out.type = out.type || 'button';
      return out;
    }
    if (m.postback?.payload) {
      out.id = m.postback.payload;
      out.type = out.type || 'postback';
      return out;
    }
    if (m.text?.body) {
      out.text = String(m.text.body).trim();
      out.type = out.type || 'text';
      return out;
    }
    if (m.body) {
      out.text = String(m.body).trim();
      out.type = out.type || 'text';
      return out;
    }
  } catch {}
  return out;
}

function normalizeStr(v) {
  if (v == null) return '';
  let s = String(v);
  try { s = s.normalize('NFD').replace(/\p{Diacritic}/gu, ''); } catch {}
  return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ').toLowerCase();
}

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

  const vNorm = {
    ...vars,
    lastUserMessage: normalizeStr(vars.lastUserMessage),
    lastReplyId: normalizeStr(vars.lastReplyId),
    lastReplyTitle: normalizeStr(vars.lastReplyTitle),
  };
  const cNorm = conditions.map((c) => {
    if (!c) return c;
    const type = c.type?.toLowerCase?.();
    if (['equals','not_equals','contains','starts_with','ends_with'].includes(type)) {
      return { ...c, value: normalizeStr(c.value) };
    }
    return c;
  });
  return evaluateConditions(cNorm, vNorm);
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

  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  const onErrorId = resolveOnErrorId(flow);

  const session = await loadSession(userId);
  let sessionVars = { ...(vars || {}), ...(session?.vars || {}) };
  if (!sessionVars.channel) sessionVars.channel = CHANNELS.WHATSAPP;

  let currentBlockId = null;

  // sessão já em humano?
  if (session?.current_block === 'human') {
    const sVars = { ...(session?.vars || {}) };
    if (sVars?.handover?.status === 'closed') {
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
      try { await distribuirTicket(rawUserId, sVars.fila, sVars.channel); } catch (e) {
        console.error('[flowExecutor] Falha ao distribuir ticket (sessão humana):', e);
      }
      return null;
    }
  }

  // inicial: parse e retomada/start
  if (currentBlockId == null) {
    const inbound = parseInboundMessage(message);

    if (session?.current_block && flow.blocks[session.current_block]) {
      const stored = session.current_block;
      if (stored === 'despedida') {
        currentBlockId = flow.start;
      } else {
        const awaiting = flow.blocks[stored];
        if (awaiting.actions && awaiting.actions.length > 0) {
          if (!message) return null;
          let next = determineNextSmart(awaiting, {
            ...sessionVars,
            lastUserMessage: inbound.title ?? inbound.text ?? inbound.id ?? '',
            lastReplyId: inbound.id ?? null,
            lastReplyTitle: inbound.title ?? null,
            lastMessageType: inbound.type ?? null
          }, flow, stored);
          if (!next && onErrorId) next = onErrorId;
          currentBlockId = next || stored;
        } else {
          currentBlockId = stored;
        }
      }
    } else {
      currentBlockId = flow.start;
    }

    sessionVars.lastUserMessage = inbound.title ?? inbound.text ?? inbound.id ?? '';
    sessionVars.lastReplyId = inbound.id ?? null;
    sessionVars.lastReplyTitle = inbound.title ?? null;
    sessionVars.lastMessageType = inbound.type ?? null;
  }

  let lastResponse = null;

  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    /* ---------- HUMAN + horários por fila ---------- */
    if (block.type === 'human') {
      if (block.content?.queueName) {
        sessionVars.fila = block.content.queueName;
        console.log(`[🧭 fila do bloco: ${sessionVars.fila}]`);
      }

      const bhCfg = await loadQueueBH(sessionVars.fila);
      const { open } = bhCfg ? isOpenNow(bhCfg) : { open: true };

      sessionVars.offhours = !open;
      sessionVars.offhours_queue = sessionVars.fila || null;

      if (!open) {
        if (bhCfg?.off_hours) {
          await sendConfiguredMessage(bhCfg.off_hours, {
            channel: sessionVars.channel || CHANNELS.WHATSAPP,
            userId, io
          });
        }

        // 1º tenta actions do bloco (ex.: offhours == true)
        let nextBlock = determineNextSmart(block, sessionVars, flow, currentBlockId);

        // 2º fallback do config (id/label)
        if (!nextBlock) {
          const cfgNext = resolveByIdOrLabel(flow, bhCfg?.off_hours?.next);
          nextBlock = cfgNext || (flow.blocks?.offhours ? 'offhours' : onErrorId);
        }
        nextBlock = nextBlock || currentBlockId;

        await saveSession(userId, nextBlock, flow.id, sessionVars);
        currentBlockId = nextBlock;
        continue; // NÃO abre handover quando fechado
      }

      // aberto: manda pre-human uma única vez
      const preEnabled = bhCfg?.pre_human?.enabled !== false;
      const preAlreadySent = !!(sessionVars.handover?.preMsgSent);
      if (preEnabled && !preAlreadySent) {
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

      await saveSession(userId, 'human', flow.id, sessionVars);

      try { await distribuirTicket(rawUserId, sessionVars.fila, sessionVars.channel); } catch (e) {
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
      } catch (e) {
        console.error('[flowExecutor] Erro ao montar conteúdo do bloco:', e);
        content = '';
      }
    }

    try {
      if (block.type === 'api_call') {
        const url = substituteVariables(block.url, sessionVars);
        const payload = block.body
          ? JSON.parse(substituteVariables(JSON.stringify(block.body), sessionVars))
          : undefined;

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
      if (block.sendDelayInSeconds) {
        const ms = Number(block.sendDelayInSeconds) * 1000;
        if (!Number.isNaN(ms) && ms > 0) await new Promise(r => setTimeout(r, ms));
      }
      try {
        const messageContent = (typeof content === 'string') ? { text: content } : content;
        const pendingRecord = await sendMessageByChannel(
          sessionVars.channel || CHANNELS.WHATSAPP,
          userId, block.type, messageContent
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
      const back = sessionVars.previousBlock;
      nextBlock = (back && flow.blocks[back]) ? back : flow.start;
    } else {
      nextBlock = determineNextSmart(block, sessionVars, flow, currentBlockId);
    }

    let resolvedBlock = block.awaitResponse ? currentBlockId : nextBlock;

    if (typeof resolvedBlock === 'string' && resolvedBlock.includes('{')) {
      resolvedBlock = substituteVariables(resolvedBlock, sessionVars);
    }

    if (resolvedBlock && !flow.blocks[resolvedBlock]) {
      resolvedBlock = onErrorId || null;
    }

    const redirectingToStart =
      resolvedBlock === flow.start && currentBlockId !== flow.start;
    if (redirectingToStart) {
      await saveSession(userId, flow.start, flow.id, sessionVars);
      break;
    }

    if (currentBlockId !== onErrorId && resolvedBlock && resolvedBlock !== onErrorId) {
      sessionVars.previousBlock = currentBlockId;
    }

    await saveSession(userId, resolvedBlock, flow.id, sessionVars);

    if (block.awaitResponse) break;

    if (
      block.awaitTimeInSeconds != null &&
      block.awaitTimeInSeconds !== false &&
      !isNaN(Number(block.awaitTimeInSeconds)) &&
      Number(block.awaitTimeInSeconds) > 0
    ) {
      await new Promise(r => setTimeout(r, Number(block.awaitTimeInSeconds) * 1000));
    }

    currentBlockId = resolvedBlock;
  }

  return lastResponse;
}
