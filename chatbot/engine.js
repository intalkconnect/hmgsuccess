import { getSession, saveSession } from './modules/sessionManager.js';
import { evaluateConditions } from './modules/evaluateConditions.js';
import { executeBlock } from './modules/blockHandlers.js';
import { dispatchMessage } from './modules/messageDispatcher.js';

export async function processMessage(message, flow, vars, rawUserId) {
  const userId = `${rawUserId}@c.wa.msginb.net`;
  if (!flow || !flow.blocks || !flow.start) return flow?.onError?.content;

  // carrega ou inicializa sessão
  let session = await getSession(userId, flow, vars);
  let current = session.current_block;
  let lastResponse = null;

  // loop principal
  while (current) {
    const block = flow.blocks[current];
    const { content, nextBlock, delaySec } = await executeBlock(block, session.vars, message);

    // delay antes de enviar
    if (delaySec) await new Promise(r => setTimeout(r, delaySec * 1000));

    // envia mensagem no canal apropriado
    lastResponse = await dispatchMessage(session.vars.channel, userId, block.type, content, session.vars.lastMessageId);

    // calcula próximo bloco
    const chosen = flow.blocks[current].actions?.find(a => evaluateConditions(a.conditions, session.vars));
    const next = chosen ? chosen.next : (flow.blocks[current].awaitResponse ? current : nextBlock);

    // atualiza sessão
    await saveSession(userId, next, flow.id, session.vars);

    if (flow.blocks[current].awaitResponse) break;
    current = next;
  }

  return lastResponse;
}
