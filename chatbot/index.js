// engine/index.js
import { processFlow } from './flowExecutor.js';
import { loadSession, saveSession } from './sessionManager.js';

export async function processMessage(message, flow, vars, rawUserId) {
  const userId = `${rawUserId}@c.wa.msginb.net`;
  const session = await loadSession(userId);
  return processFlow(message, flow, vars, session, userId);
}
