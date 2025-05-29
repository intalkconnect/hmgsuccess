import Fastify from 'fastify';
import dotenv from 'dotenv';
import webhookRoutes from './routes/webhook.js';
import messageRoutes from './routes/messages.js';
import flowRoutes from './routes/flow.js';
import { initDB } from './services/db.js';

dotenv.config();

const fastify = Fastify({ logger: true });

// Inicializa conexão com Supabase
await initDB();

fastify.register(webhookRoutes, { prefix: '/webhook' });
fastify.register(messageRoutes, { prefix: '/messages' });
fastify.register(flowRoutes, { prefix: '/flow' });

fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) throw err;
  fastify.log.info(`Servidor rodando em ${address}`);
});
