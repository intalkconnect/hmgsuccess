// engine/queueHoursService.js
import { initDB, pool } from './services/db.js';

let cache = new Map();
let ts = new Map();
const TTL_MS = 60_000; // 1 min

export async function loadQueueBH(queueName) {
  if (!queueName) return null;

  const now = Date.now();
  if (cache.has(queueName) && now - (ts.get(queueName) || 0) < TTL_MS) {
    return cache.get(queueName);
  }

  await initDB(); // garante pool

  const sql = `
    SELECT queue_name, timezone, hours, holidays, exceptions, pre_human, off_hours
    FROM queue_business_hours
    WHERE queue_name = $1
  `;
  const { rows } = await pool.query(sql, [queueName]);
  const row = rows[0] || null;

  // Normaliza campos (evita undefined)
  const cfg = row ? {
    queue_name: row.queue_name,
    timezone: row.timezone || 'America/Sao_Paulo',
    hours: row.hours || {},
    holidays: row.holidays || [],
    exceptions: row.exceptions || {},
    pre_human: row.pre_human || null,
    off_hours: row.off_hours || null
  } : null;

  cache.set(queueName, cfg);
  ts.set(queueName, now);
  return cfg;
}
