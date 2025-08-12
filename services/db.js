// services/db.js
import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL não definido');
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
  // boas práticas:
  max: Number(process.env.PG_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * Resolve o subdomínio a partir do Host.
 * ex.: hmg.dkdevs.com.br -> 'hmg'
 */
export function extractSubdomain(hostHeader, baseDomain = process.env.BASE_DOMAIN) {
  if (!hostHeader) return null;
  const host = hostHeader.split(':')[0].toLowerCase(); // remove :porta
  if (!baseDomain) return null; // defina BASE_DOMAIN=dkdevs.com.br
  if (host === baseDomain) return null;

  const suffix = '.' + baseDomain;
  if (!host.endsWith(suffix)) return null;

  const sub = host.slice(0, -suffix.length);
  // evita coisas como "www"
  if (sub === 'www' || !sub) return null;
  return sub;
}

/**
 * Lookup no catálogo global -> retorna schema do tenant.
 */
export async function lookupSchemaBySubdomain(subdomain) {
  if (!subdomain) return null;
  const q = 'SELECT schema_name FROM public.tenants WHERE subdomain = $1';
  const { rows } = await pool.query(q, [subdomain]);
  return rows[0]?.schema_name || null;
}

/**
 * Executa callback dentro de uma TX com search_path=<schema>,public
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
 * Escapa identificadores para SET search_path com segurança.
 * (equivalente a format('%I', ident) do Postgres)
 */
function pgFormatIdent(ident) {
  // muito conservador: só permite [a-z0-9_], senão cerca com aspas duplas escapadas
  if (/^[a-z0-9_]+$/.test(ident)) return ident;
  return `"${ident.replace(/"/g, '""')}"`;
}
