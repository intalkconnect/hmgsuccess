// plugins/tenant.js
import fp from 'fastify-plugin';
import { extractSubdomain, lookupSchemaBySubdomain, withTenant } from '../services/db.js';

export default fp(async function tenantPlugin(fastify) {
  fastify.decorateRequest('tenant', null);
  fastify.decorateRequest('db', null);

  fastify.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;

    // 1) tenta header x-tenant; 2) cai pro subdomínio
    const headerTenant = (req.headers['x-tenant'] || '').trim().toLowerCase();
    const sub = headerTenant || extractSubdomain(req.headers.host);

    const schema = await lookupSchemaBySubdomain(sub);
    if (!schema) {
      req.log.warn({ host: req.headers.host, sub }, 'tenant não encontrado');
      return reply.code(404).send({ ok: false, error: 'tenant_not_found' });
    }

    req.tenant = { subdomain: sub, schema };

    // executores por request
    req.db = {
      tx: (fn) => withTenant(schema, fn),
      query: (text, params) => withTenant(schema, (c) => c.query(text, params)),
    };
  });
});
