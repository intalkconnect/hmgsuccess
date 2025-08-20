// services/high/handleTicketStatusEvent.js
import { loadSession, saveSession } from '../../engine/sessionManager.js';
import { SYSTEM_EVT_TICKET_STATUS, TICKET_STATUS } from '../../engine/messageTypes.js';

const toRaw = (storageUserId) => {
  const s = String(storageUserId || '');
  const i = s.indexOf('@');
  return i > -1 ? s.slice(0, i) : s;
};

export async function handleTicketStatusEvent(evt /*, { io } */) {
  if (evt.type !== SYSTEM_EVT_TICKET_STATUS) return { ok: true, resume: false };
  const status = String(evt.status || '').toLowerCase();
  if (status !== TICKET_STATUS.CLOSED) return { ok: true, resume: false };

  const storageUserId = evt.userId;
  const rawUserId = toRaw(storageUserId);
  const number = evt.ticketNumber || null;
  const fila = evt.fila || null;

  const session = await loadSession(storageUserId);
  if (!session) return { ok: false, reason: 'no-session', resume: false };

  const vars = { ...(session.vars || {}) };

  // ✅ grava o NÚMERO FINAL do ticket na saída
  vars.ticket = {
    ...(vars.ticket || {}),
    number: number || vars.ticket?.number || null,
    fila: fila || vars.ticket?.fila || vars.fila || null
  };

  // ✅ marca fechamento do handover
  vars.handover = { ...(vars.handover || {}), status: 'closed', result: 'closed' };

  // mantém current_block = 'human' — o executor vai retomar pelas actions do bloco human
  await saveSession(storageUserId, 'human', session.flow_id, vars);

  // 👉 Deixa o processEvent carregar o fluxo do JEITO PADRÃO e chamar runFlow
  return { ok: true, resume: true, storageUserId, rawUserId, flowId: session.flow_id };
}
