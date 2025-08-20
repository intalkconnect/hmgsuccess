// engine/queueHoursService.js
let cache = new Map();
let cacheTtlMs = 60_000; // 1 minuto
let last = new Map();

async function fromRepo(queueName) {
  try {
    const mod = await import('../server/db/queueBusinessHoursRepo.js'); // ajuste caminho se necessário
    const { getQueueBH } = mod;
    return await getQueueBH(queueName);
  } catch {
    return null;
  }
}

async function fromHttp(queueName) {
  try {
    const base = process.env.INTERNAL_BASE_URL || 'http://localhost:3000/api';
    const res = await fetch(`${base}/queues/${encodeURIComponent(queueName)}/business-hours`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function loadQueueBH(queueName) {
  if (!queueName) return null;
  const now = Date.now();
  if (cache.has(queueName) && now - (last.get(queueName) || 0) < cacheTtlMs) {
    return cache.get(queueName);
  }
  const fromDb = await fromRepo(queueName);
  const cfg = fromDb || await fromHttp(queueName);
  if (cfg) {
    cache.set(queueName, cfg);
    last.set(queueName, now);
  }
  return cfg;
}
