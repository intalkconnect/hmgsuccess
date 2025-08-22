// engine/queueHoursService.js
import * as db from './services/db.js';

const cache = new Map();
const ts = new Map();
const TTL_MS = 60_000; // 1 min

function getRunner() {
  if (typeof db.query === 'function') return db.query;
  if (db.pool && typeof db.pool.query === 'function') return db.pool.query.bind(db.pool);
  if (db.dbPool && typeof db.dbPool.query === 'function') return db.dbPool.query.bind(db.dbPool);
  throw new Error('[queueHoursService] Nenhum runner de query disponível');
}

function toHHMM(mins) {
  const m = Math.max(0, Math.min(1439, Number(mins) || 0));
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

const IDX2KEY = ['sun','mon','tue','wed','thu','fri','sat']; // 0=Dom ... 6=Sáb

export async function loadQueueBH(queueName) {
  if (!queueName) return null;

  const key = String(queueName).toLowerCase();
  const now = Date.now();
  if (cache.has(key) && now - (ts.get(key) || 0) < TTL_MS) {
    return cache.get(key);
  }

  if (typeof db.initDB === 'function') {
    await db.initDB();
  }
  const runQuery = getRunner();

  // 1) Config “macro” (timezone, feriados, mensagens, etc.)
  const sqlCfg = `
    SELECT queue_name, timezone, holidays, exceptions, pre_human, off_hours, hours
    FROM queue_business_hours
    WHERE lower(queue_name) = lower($1)
    LIMIT 1
  `;
  const { rows: cfgRows } = await runQuery(sqlCfg, [queueName]);
  const base = cfgRows?.[0] || { queue_name: queueName };

  const timezone = base.timezone || 'America/Sao_Paulo';

  // Começa com hours do JSON (se existir) para manter compatibilidade
  const hours = {};
  const preload = base.hours || {};
  for (const k of Object.keys(preload)) {
    hours[k] = Array.isArray(preload[k]) ? [...preload[k]] : [];
  }

  // 2) Janelas em minutos (tabela que você mostrou no print)
  const sqlWin = `
    SELECT weekday, start_minute, end_minute
    FROM queue_hours
    WHERE lower(queue_name) = lower($1)
    ORDER BY weekday, start_minute
  `;
  const { rows: winRows } = await runQuery(sqlWin, [queueName]);

  for (const r of winRows) {
    const idx = Number(r.weekday);              // 0..6 (0=Domingo)
    const keyDay = IDX2KEY[idx] ?? 'mon';
    const start = toHHMM(r.start_minute);
    const end   = toHHMM(r.end_minute);
    if (!hours[keyDay]) hours[keyDay] = [];
    hours[keyDay].push({ start, end });
  }

  const cfg = {
    queue_name: base.queue_name || queueName,
    timezone,
    hours,                       // <- no formato que o isOpenNow espera
    holidays: base.holidays || [],
    exceptions: base.exceptions || {},
    pre_human: base.pre_human || null,
    off_hours: base.off_hours || null,
    // aliases antigos (se algum lugar ainda usa):
    tz: timezone,
    schedule: hours
  };

  cache.set(key, cfg);
  ts.set(key, now);
  return cfg;
}
