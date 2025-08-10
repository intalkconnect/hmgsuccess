// utils/channel.js
import crypto from 'crypto';

export function toChannel(room) {
  const r = String(room || '').trim();
  if (r === 'broadcast') return 'broadcast';
  const hex = crypto.createHash('sha1').update(r).digest('hex'); // estável
  return `r_${hex}`; // ex.: r_f3a1...
}
