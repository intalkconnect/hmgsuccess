import { getSession, saveSession } from './modules/sessionManager.js';
import { evaluateConditions } from './modules/evaluateConditions.js';
import { executeBlock } from './modules/blockHandlers.js';
import { dispatchMessage } from './modules/messageDispatcher.js';

export async function processMessage(message, flow, vars, rawUserId) {
  const userId = `${rawUserId}@c.wa.msginb.net`;
  if (!flow || !flow.blocks || !flow.start) {
    return flow?.onError?.content || 'Erro interno no bot';
  }

  // Inicializa sessão
  let session = await getSession(userId, flow, vars);
  let current = session.current_block;
  let lastResponse = null;

  // Loop principal
  while (current) {
    const block = flow.blocks[current];
    if (!block) break;

    // Executa bloco e obtém conteúdo, próximo bloco padrão e delay
    const { content, nextBlock: defaultNext, delaySec } = await executeBlock(block, session.vars, message);

    // Delay antes de enviar, se configurado
    if (delaySec > 0) {
      await new Promise(res => setTimeout(res, delaySec * 1000));
    }

    // Envia mensagem
    lastResponse = await dispatchMessage(
      session.vars.channel,
      userId,
      block.type,
      content,
      session.vars.lastMessageId
    );

    // Determina próximo bloco pelas actions
    const action = block.actions?.find(a => evaluateConditions(a.conditions, session.vars));
    const next = action ? action.next : defaultNext;

    // Salva sessão
    await saveSession(userId, block.awaitResponse ? current : next, flow.id, session.vars);

    // Se aguardando resposta, interrompe
    if (block.awaitResponse) break;
    current = next;
  }

  return lastResponse;
}
