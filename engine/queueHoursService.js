// engine/queueHoursService.js
import { initDB, query } from './services/db.js';

const cache = new Map();
const ts = new Map();
const TTL_MS = 60_000; // 1 min

export async function loadQueueBH(queueName) {
  if (!queueName) return null;

  const key = String(queueName).toLowerCase();
  const now = Date.now();
  if (cache.has(key) && now - (ts.get(key) || 0) < TTL_MS) {
    return cache.get(key);
  }

  await initDB(); // garante pool pronto

  const sql = `
    SELECT queue_name, timezone, hours, holidays, exceptions, pre_human, off_hours
    FROM queue_business_hours
    WHERE lower(queue_name) = lower($1)
    LIMIT 1
  `;
  const { rows } = await query(sql, [queueName]);
  const row = rows[0] || null;

  if (!row) {
    cache.set(key, null);
    ts.set(key, now);
    return null;
  }

  // Normalização de chaves para compatibilidade (tz/schedule vs timezone/hours)
  const timezone = row.timezone || row.tz || 'America/Sao_Paulo';
  const schedule = row.hours || row.schedule || {}; // preferimos "hours" do seu schema atual

  const cfg = {
    queue_name: row.queue_name,
    // forma “nova”
    timezone,
    hours: schedule,
    holidays: row.holidays || [],
    exceptions: row.exceptions || {},
    pre_human: row.pre_human || null,
    off_hours: row.off_hours || null,
    // aliases p/ quem espera as chaves “antigas”
    tz: timezone,
    schedule
  };

  cache.set(key, cfg);
  ts.set(key, now);
  return cfg;
}
