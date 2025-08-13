// services/db.js
import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL não definido');
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// (compat eventual com código legado que ainda importe dbPool)
export const dbPool = pool;

/**
 * Resolve o subdomínio a partir do host (ex.: hmg.dkdevs.com.br -> 'hmg').
 * Funciona com/sem BASE_DOMAIN:
 *  - Se BASE_DOMAIN=dkdevs.com.br estiver setado, valida exatamente esse sufixo.
 *  - Sem BASE_DOMAIN, cai num fallback: se houver >= 3 labels, usa o 1º como subdomínio.
 * Ignora 'www' e hosts que são IP/localhost.
 */
export function extractSubdomain(hostHeader, baseDomain = process.env.BASE_DOMAIN) {
  if (!hostHeader) return null;
  const host = hostHeader.split(':')[0].toLowerCase().trim();
  if (!host) return null;

  // ignora IPs/localhost
  if (isIPAddress(host) || host === 'localhost') return null;

  // caminho preferido: BASE_DOMAIN definido (ex.: dkdevs.com.br)
  if (baseDomain && baseDomain.trim()) {
    const bd = baseDomain.toLowerCase().trim();
    if (host === bd) return null;
    const suffix = '.' + bd;
    if (host.endsWith(suffix)) {
      const sub = host.slice(0, -suffix.length);
      return sub && sub !== 'www' ? sub : null;
    }
    // se não bate o domínio base, não assume nada
    return null;
  }

  // fallback: 3+ labels -> pega o primeiro
  const parts = host.split('.');
  if (parts.length >= 3) {
    const sub = parts[0];
    return sub && sub !== 'www' ? sub : null;
  }

  return null;
}

function isIPAddress(h) {
  // IPv4 simples
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  // IPv6 simples (com dois-pontos)
  if (h.includes(':')) return true;
  return false;
}

/**
 * Busca no catálogo global o schema correspondente ao subdomínio.
 */
export async function lookupSchemaBySubdomain(subdomain) {
  if (!subdomain) return null;
  const q = 'SELECT schema_name FROM public.tenants WHERE subdomain = $1';
  const { rows } = await pool.query(q, [subdomain]);
  return rows[0]?.schema_name || null;
}

/**
 * Executa callback dentro de uma transação com search_path=<schema>,public.
 * Toda query via "client" já enxerga as tabelas do tenant.
 */
export async function withTenant(schema, fn) {
  if (!schema) throw new Error('schema do tenant ausente');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${pgFormatIdent(schema)}, public`);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Escapa identificadores para SET search_path com segurança
 * (equivalente a format('%I', ident) do Postgres).
 */
function pgFormatIdent(ident) {
  if (/^[a-z0-9_]+$/.test(ident)) return ident; // simples e rápido
  return `"${String(ident).replace(/"/g, '""')}"`;
}
