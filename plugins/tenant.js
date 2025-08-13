// plugins/tenant.js
import fp from 'fastify-plugin';
import { extractSubdomain, lookupSchemaBySubdomain, withTenant } from '../services/db.js';

export default fp(async function tenantPlugin(fastify) {
  fastify.decorateRequest('tenant', null);
  fastify.decorateRequest('db', null);

  fastify.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;

    // 1) tenta header x-tenant (case-insensitive)
    const headerTenant = String(req.headers['x-tenant'] || '').trim().toLowerCase();

    // 2) tenta subdomínio do Host (prioriza X-Forwarded-Host se existir)
    const forwardedHost = req.headers['x-forwarded-host'] || req.headers['host'];
    const subdomainFromHost = extractSubdomain(forwardedHost);

    // 3) opcional p/ testes locais: ?tenant=hmg
    const queryTenant = (req.query?.tenant ? String(req.query.tenant) : '').trim().toLowerCase();

    const sub = headerTenant || queryTenant || subdomainFromHost;

    let schema;
    try {
      schema = await lookupSchemaBySubdomain(sub);
    } catch (err) {
      // Quando o catálogo não existe ainda: 42P01
      if (err.code === '42P01') {
        req.log.error(err, 'Catálogo global ausente: public.tenants');
        return reply.code(500).send({
          ok: false,
          error: 'catalog_missing',
          message: 'A tabela public.tenants não existe. Rode o bootstrap SQL.'
        });
      }
      throw err;
    }

    if (!schema) {
      req.log.warn({ host: forwardedHost, sub, headerTenant, queryTenant }, 'tenant não encontrado');
      return reply.code(404).send({ ok: false, error: 'tenant_not_found' });
    }

    req.tenant = { subdomain: sub, schema };

    // executores por request (sempre usam search_path=<schema>,public)
    req.db = {
      tx: (fn) => withTenant(schema, fn),
      query: (text, params) => withTenant(schema, (c) => c.query(text, params)),
    };
  });
});
