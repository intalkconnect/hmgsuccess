// engine/flowExecutor.js
import { substituteVariables } from '../utils/vars.js';
import { evaluateConditions, determineNextBlock } from './utils.js';
import { supabase } from '../services/db.js';
import { sendWhatsappMessage, markAsReadAndTyping } from '../services/sendWhatsappMessage.js';
import { sendWebchatMessage } from '../services/sendWebchatMessage.js';
import axios from 'axios';
import vm from 'vm';

async function sendMessageByChannel(channel, to, type, content) {
  if (channel === 'webchat') {
    return sendWebchatMessage({ to, content });
  }
  let whatsappContent =
    type === 'text' && typeof content === 'string' ? { body: content } : content;
  return sendWhatsappMessage({ to, type, content: whatsappContent });
}

export async function runFlow({ message, flow, vars, rawUserId }) {
  const userId = `${rawUserId}@c.wa.msginb.net`;
  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  const { data: session } = await supabase
    .from('sessions')
    .select('*')
    .eq('user_id', userId)
    .single();

  let sessionVars = { ...vars, ...(session?.vars || {}) };
  let currentBlockId = null;

  if (session?.current_block === 'atendimento_humano') {
    await supabase.from('sessions').upsert([{
      user_id: userId,
      current_block: 'atendimento_humano',
      last_flow_id: flow.id || null,
      vars: session?.vars || {},
      updated_at: new Date().toISOString(),
    }]);
    return null;
  }

  if (session?.current_block && flow.blocks[session.current_block]) {
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
        for (const action of awaiting.actions || []) {
          if (evaluateConditions(action.conditions, sessionVars)) {
            currentBlockId = action.next;
            break;
          }
        }
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

  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    if (block.type === 'human') {
      await supabase.from('sessions').upsert([{
        user_id: userId,
        current_block: currentBlockId,
        last_flow_id: flow.id || null,
        vars: sessionVars,
        updated_at: new Date().toISOString(),
      }]);
      return null;
    }

    let content = '';
    try {
      if (block.content != null) {
        content = typeof block.content === 'string'
          ? substituteVariables(block.content, sessionVars)
          : JSON.parse(substituteVariables(JSON.stringify(block.content), sessionVars));
      }

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

      if (content && ['text','image','audio','video','file','document','location','interactive'].includes(block.type)) {
        if (message?.id) await markAsReadAndTyping(message.id);
        if (block.sendDelayInSeconds) await new Promise(r => setTimeout(r, block.sendDelayInSeconds * 1000));
        try {
          await sendMessageByChannel(sessionVars.channel || 'whatsapp', userId, block.type, content);
        } catch (mediaErr) {
          const fallback = (typeof content === 'object' && content.url)
            ? `Aqui está seu conteúdo: ${content.url}`
            : `Aqui está sua mensagem: ${content}`;
          await sendMessageByChannel(sessionVars.channel || 'whatsapp', userId, 'text', fallback);
        }
        lastResponse = content;
      }

      let nextBlock = determineNextBlock(block, sessionVars, flow, currentBlockId);

      let resolvedBlock = block.awaitResponse ? currentBlockId : nextBlock;
      if (typeof resolvedBlock === 'string' && resolvedBlock.includes('{')) {
        resolvedBlock = substituteVariables(resolvedBlock, sessionVars);
      }
      if (!flow.blocks[resolvedBlock]) {
        resolvedBlock = 'onerror';
      }

      if (
        currentBlockId !== 'onerror' &&
        resolvedBlock !== 'onerror' &&
        (!sessionVars.previousBlock || sessionVars.previousBlock !== resolvedBlock)
      ) {
        sessionVars.previousBlock = currentBlockId;
      }

      await supabase.from('sessions').upsert([{
        user_id: userId,
        current_block: resolvedBlock,
        last_flow_id: flow.id || null,
        vars: sessionVars,
        updated_at: new Date().toISOString(),
      }]);

      if (block.awaitResponse) break;
      const delay = parseInt(block.awaitTimeInSeconds || '0', 10);
      if (delay > 0) await new Promise(r => setTimeout(r, delay * 1000));

      currentBlockId = resolvedBlock;
    } catch (err) {
      console.error('Erro no bloco', currentBlockId, err);
      break;
    }
  }

  return lastResponse;
}
