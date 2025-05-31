// engine/flowExecutor.js
import { evaluateConditions } from './utils.js';
import { sendMessageByChannel, markAsReadIfNeeded } from './messenger.js';
import { saveSession } from './sessionManager.js';
import { runApiCall, runScript } from './runners.js';
import { substituteVariables } from '../utils/vars.js';

export async function processFlow(message, flow, vars, session, userId) {
  let currentBlockId = session?.current_block || flow.start;
  let sessionVars = { ...vars, ...(session?.vars || {}) };

  if (session?.current_block === 'atendimento_humano') return null;
  if (!flow?.blocks?.[currentBlockId]) return null;

  if (currentBlockId === 'despedida') {
    currentBlockId = flow.start;
    sessionVars = { lastUserMessage: message };
  } else if (flow.blocks[currentBlockId]?.awaitResponse && message) {
    sessionVars.lastUserMessage = message;
    for (const action of flow.blocks[currentBlockId].actions || []) {
      if (evaluateConditions(action.conditions, sessionVars)) {
        currentBlockId = action.next;
        break;
      }
    }
    if (!flow.blocks[currentBlockId]) return null;
  }

  let lastResponse = null;
  while (currentBlockId) {
    const block = flow.blocks[currentBlockId];
    if (!block) break;

    let content = '';
    if (block.content != null) {
      content = typeof block.content === 'string'
        ? substituteVariables(block.content, sessionVars)
        : JSON.parse(substituteVariables(JSON.stringify(block.content), sessionVars));
    }

    switch (block.type) {
      case 'api_call':
        content = await runApiCall(block, sessionVars);
        break;
      case 'script':
        content = await runScript(block, sessionVars);
        break;
    }

    if (['text','image','audio','video','file','document','location','interactive'].includes(block.type)) {
      await markAsReadIfNeeded(message);
      lastResponse = await sendMessageByChannel(sessionVars.channel || 'whatsapp', userId, block.type, content);
    }

    let nextBlock = null;
    for (const action of block.actions || []) {
      if (evaluateConditions(action.conditions, sessionVars)) {
        nextBlock = action.next;
        break;
      }
    }
    if (!nextBlock && block.defaultNext && flow.blocks[block.defaultNext]) {
      nextBlock = block.defaultNext;
    }

    const resolvedBlock = block.awaitResponse ? currentBlockId : nextBlock;
    if (!flow.blocks[resolvedBlock]) break;

    if (currentBlockId !== 'onerror' && resolvedBlock !== 'onerror') {
      sessionVars.previousBlock = currentBlockId;
    }

    await saveSession(userId, resolvedBlock, flow.id, sessionVars);
    if (block.awaitResponse) break;
    currentBlockId = resolvedBlock;
  }

  return lastResponse;
}
