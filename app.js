import Fastify from 'fastify';
import dotenv from 'dotenv';
import webhookRoutes from './routes/webhook.js';
import messageRoutes from './routes/messages.js';
import { initDB } from './services/db.js';

dotenv.config();

const fastify = Fastify({ logger: true });

// Inicializa conexão com Supabase
await initDB();

fastify.register(webhookRoutes, { prefix: '/webhook' });
fastify.register(messageRoutes, { prefix: '/messages' });

fastify.listen({ port: process.env.PORT || 3000 }, (err, address) => {
  if (err) throw err;
  fastify.log.info(`Servidor rodando em ${address}`);
});