// app.js
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart"; // ✅ necessário para multipart/form-data
import dotenv from "dotenv";
import { Server as IOServer } from "socket.io";

import webhookRoutes from "./routes/webhook.js";
import messageRoutes from "./routes/messages.js";
import flowRoutes from "./routes/flow.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import conversationsRoutes from './routes/conversations.js'
import settingsRoutes from './routes/settingsRoutes.js'
import clientesRoutes from './routes/clientes.js';
import { initDB, pool } from "./services/db.js";


dotenv.config();

async function buildServer() {
  const fastify = Fastify({ logger: true });

  await fastify.register(cors, { origin: "*" });

  // ✅ Registro global do suporte a uploads multipart/form-data
  await fastify.register(multipart);

await initDB();
fastify.decorate('pool', pool);
fastify.log.info("[initDB] Conexão com PostgreSQL estabelecida.");

  return fastify;
}

async function start() {
  const fastify = await buildServer();

  const io = new IOServer(fastify.server, {
    cors: { origin: "*" },
  });

  fastify.decorate("io", io);

  io.on("connection", (socket) => {
    fastify.log.info(`[Socket.IO] Cliente conectado: ${socket.id}`);

    socket.on("join_room", (userId) => {
      const normalizedId = userId.includes("@")
        ? userId
        : `${userId}@w.msgcli.net`;
      socket.join(`chat-${normalizedId}`);
      fastify.log.info(
        `[Socket.IO] Socket ${socket.id} entrou na sala chat-${normalizedId}`
      );
    });

    socket.on("leave_room", (userId) => {
      socket.leave(`chat-${userId}`);
      fastify.log.info(
        `[Socket.IO] Socket ${socket.id} saiu da sala chat-${userId}`
      );
    });

    socket.on("disconnect", (reason) => {
      fastify.log.info(
        `[Socket.IO] Cliente desconectado: ${socket.id} (reason=${reason})`
      );
    });
  });

  fastify.log.info("[start] Registrando rotas...");
  fastify.register(webhookRoutes, { prefix: "/webhook" });
  fastify.register(messageRoutes, { prefix: "/messages" });
  fastify.register(flowRoutes, { prefix: "/flow" });
  fastify.register(uploadRoutes, { prefix: "/bucket" }); // ✅ upload com multipart
  fastify.register(conversationsRoutes, { prefix: "/conversations" });
  fastify.register(settingsRoutes, { prefix: "/settings" });
  fastify.register(clientesRoutes, { prefix: '/clientes' });
  fastify.log.info("[start] Rotas registradas com sucesso.");

  const PORT = process.env.PORT || 3000;
  try {
    fastify.log.info(`[start] Iniciando servidor na porta ${PORT}...`);
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    fastify.log.info(`[start] Servidor rodando em http://0.0.0.0:${PORT}`);
  } catch (err) {
    fastify.log.error(err, "[start] Erro ao iniciar servidor");
    process.exit(1);
  }
}

start();
