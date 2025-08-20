// services/high/handleTicketStatusEvent.js
import { loadSession, saveSession } from '../../engine/sessionManager.js';
import { runFlow } from '../../engine/flowExecutor.js';
import { SYSTEM_EVT_TICKET_STATUS, TICKET_STATUS } from '../../engine/messageTypes.js';
// ajuste para seu loader real do fluxo:
import { loadFlowDefinition } from '../../engine/flowStore.js'; // implemente/aponte para seu storage

const toRaw = (storageUserId) => {
  const s = String(storageUserId || '');
  const i = s.indexOf('@');
  return i > -1 ? s.slice(0, i) : s;
};

export async function handleTicketStatusEvent(evt, { io }) {
  if (evt.type !== SYSTEM_EVT_TICKET_STATUS) return 'ignored';
  const status = String(evt.status || '').toLowerCase();
  if (status !== TICKET_STATUS.CLOSED) return 'ignored';

  const storageUserId = evt.userId;
  const rawUserId = toRaw(storageUserId);
  const number = evt.ticketNumber || null;
  const fila = evt.fila || null;

  const session = await loadSession(storageUserId);
  if (!session) return 'no-session';

  const vars = { ...(session.vars || {}) };

  // ticket: grava o NÚMERO FINAL somente aqui (saída)
  vars.ticket = {
    ...(vars.ticket || {}),
    number: number || vars.ticket?.number || null,
    fila: fila || vars.ticket?.fila || vars.fila || null
  };

  // handover: marcar fechado
  vars.handover = { ...(vars.handover || {}), status: 'closed', result: 'closed' };

  // mantém current_block = 'human' — o executor retoma pelas actions do bloco human
  await saveSession(storageUserId, 'human', session.flow_id, vars);

  // retomar agora
  const flow = await loadFlowDefinition(session.flow_id);
  await runFlow({ message: null, flow, vars: undefined, rawUserId, io });
  return 'resumed';
}
