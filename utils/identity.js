// src/utils/identity.js
export const normalizeChannel = (raw) =>
  String(raw || '').toLowerCase().trim();

export const makeUserId = (id, channel) =>
  `${String(id).trim()}@${normalizeChannel(channel)}`;

export const parseUserId = (userId) => {
  const s = String(userId || '');
  const at = s.lastIndexOf('@');
  if (at === -1) return { id: s, channel: '' };
  return { id: s.slice(0, at), channel: s.slice(at + 1) };
};
