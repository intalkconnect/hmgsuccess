// plugins/tenant.js
import fp from 'fastify-plugin';
import { extractSubdomain, lookupSchemaBySubdomain, withTenant } from '../services/db.js';

export default fp(async function tenantPlugin(fastify) {
  fastify.decorateRequest('tenant', null);
  fastify.decorateRequest('db', null);

  fastify.addHook('onRequest', async (req, reply) => {
    // permite bypass para healthz e rotas públicas, se quiser
    if (req.url === '/healthz') return;

    const sub = extractSubdomain(req.headers.host);
    const schema = await lookupSchemaBySubdomain(sub);

    if (!schema) {
      req.log.warn({ host: req.headers.host, sub }, 'tenant não encontrado');
      return reply.code(404).send({ ok: false, error: 'tenant_not_found' });
    }

    req.tenant = { subdomain: sub, schema };

    // cria um "executor" por-req:
    req.db = {
      /**
       * Executa uma função recebendo um "client" do pg,
       * já com search_path do tenant configurado.
       * Uso: await req.db.tx(client => client.query(...))
       */
      tx: (fn) => withTenant(schema, fn),

      /**
       * Açúcar sintático pra uma única query.
       */
      query: (text, params) => withTenant(schema, (c) => c.query(text, params)),
    };
  });
});
