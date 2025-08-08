// src/utils/identity.js
const SUFFIXES = {
  whatsapp: '@w.msgcli.net',
  telegram: '@telegram',
  webchat: '@webchat'
};

export function normalizeChannel(input) {
  // aceita 'whatsapp' | '@w.msgcli.net' | 'telegram' | '@telegram' | ...
  if (!input) return SUFFIXES.whatsapp;
  const raw = String(input).toLowerCase();
  if (raw.startsWith('@')) return raw;
  return SUFFIXES[raw] || raw;
}

export function suffixToChannelName(suffix) {
  // '@telegram' -> 'telegram'; '@w.msgcli.net' -> 'whatsapp'
  const entry = Object.entries(SUFFIXES).find(([, s]) => s === suffix);
  return entry ? entry[0] : 'desconhecido';
}

export function makeUserId(id, channelOrSuffix) {
  const suffix = normalizeChannel(channelOrSuffix);
  return `${String(id)}${suffix}`;
}

export function splitUserId(userId) {
  // '123@telegram' => { id:'123', suffix:'@telegram', channel:'telegram' }
  const [id, ...rest] = String(userId).split('@');
  const suffix = '@' + rest.join('@');
  return { id, suffix, channel: suffixToChannelName(suffix) };
}
