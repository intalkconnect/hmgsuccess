// engine/queueHoursService.js
import * as db from './services/db.js';

const cache = new Map();
const ts = new Map();
const TTL_MS = 60_000; // 1 min

function getRunner() {
  // Prioriza a função query(text, params)
  if (typeof db.query === 'function') return db.query;
  // Depois tenta pool.query
  if (db.pool && typeof db.pool.query === 'function') return db.pool.query.bind(db.pool);
  // Depois tenta dbPool.query (já que db.js exporta dbPool)
  if (db.dbPool && typeof db.dbPool.query === 'function') return db.dbPool.query.bind(db.dbPool);
  throw new Error('[queueHoursService] Nenhum runner de query disponível');
}

export async function loadQueueBH(queueName) {
  if (!queueName) return null;

  const key = String(queueName).toLowerCase();
  const now = Date.now();
  if (cache.has(key) && now - (ts.get(key) || 0) < TTL_MS) {
    return cache.get(key);
  }

  // garante pool/conn viva
  if (typeof db.initDB === 'function') {
    await db.initDB();
  }

  const runQuery = getRunner();

  const sql = `
    SELECT queue_name, timezone, hours, holidays, exceptions, pre_human, off_hours
    FROM queue_business_hours
    WHERE lower(queue_name) = lower($1)
    LIMIT 1
  `;
  const { rows } = await runQuery(sql, [queueName]);
  const row = rows?.[0] || null;

  if (!row) {
    cache.set(key, null);
    ts.set(key, now);
    return null;
  }

  // Normalização: aceita timezone/hours, e expõe aliases tz/schedule
  const timezone = row.timezone || row.tz || 'America/Sao_Paulo';
  const schedule = row.hours || row.schedule || {};   // preferencialmente "hours" do seu schema atual

  const cfg = {
    queue_name: row.queue_name,
    timezone,
    hours: schedule,
    holidays: row.holidays || [],
    exceptions: row.exceptions || {},
    pre_human: row.pre_human || null,
    off_hours: row.off_hours || null,
    // aliases p/ compat com chamadas antigas
    tz: timezone,
    schedule: schedule
  };

  cache.set(key, cfg);
  ts.set(key, now);
  return cfg;
}
