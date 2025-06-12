import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import dotenv from 'dotenv';
import { Server as IOServer } from 'socket.io';

// ... (other imports remain the same) ...

async function start() {
  const fastify = await buildServer();
  const io = new IOServer(fastify.server, { 
    cors: { origin: '*' },
    connectionStateRecovery: {
      maxDisconnectionDuration: 30000
    }
  });
  fastify.decorate('io', io);

  const userConnections = new Map();

  async function updateAtendenteStatus(email, status) {
    try {
      await fastify.pg.query(
        'UPDATE atendentes SET status = $1, last_activity = NOW() WHERE email = $2',
        [status, email]
      );
      fastify.log.info(`[Status] Atendente ${email} set to ${status}`);
    } catch (err) {
      fastify.log.error(err, `[Status] Error updating status for ${email}`);
    }
  }

  io.on('connection', (socket) => {
    const email = socket.handshake.auth.email;
    if (!email) {
      socket.disconnect();
      return;
    }

    // Clear any existing connection for this email
    if (userConnections.has(email)) {
      clearTimeout(userConnections.get(email).timeout);
    }

    // Set new connection
    userConnections.set(email, {
      socketId: socket.id,
      lastHeartbeat: Date.now()
    });

    // Update status to online
    updateAtendenteStatus(email, 'online');

    // Heartbeat handler
    socket.on('heartbeat', () => {
      if (userConnections.has(email)) {
        userConnections.get(email).lastHeartbeat = Date.now();
      }
    });

    // Setup inactivity check
    const checkInactivity = () => {
      if (!userConnections.has(email)) return;

      const connection = userConnections.get(email);
      const inactiveTime = Date.now() - connection.lastHeartbeat;
      
      if (inactiveTime > 30000) { // 30 seconds
        userConnections.delete(email);
        updateAtendenteStatus(email, 'offline');
      } else {
        connection.timeout = setTimeout(checkInactivity, 30000 - inactiveTime + 1000);
      }
    };

    const timeout = setTimeout(checkInactivity, 30000);
    userConnections.get(email).timeout = timeout;

    socket.on('disconnect', async () => {
      if (userConnections.has(email)) {
        clearTimeout(userConnections.get(email).timeout);
        userConnections.delete(email);
        await updateAtendenteStatus(email, 'offline');
      }
    });

    socket.on('atendente_offline', async () => {
      if (userConnections.has(email)) {
        clearTimeout(userConnections.get(email).timeout);
        userConnections.delete(email);
        await updateAtendenteStatus(email, 'offline');
      }
    });

    socket.on('join_room', (userId) => {
      const normalized = userId.includes('@') ? userId : `${userId}@w.msgcli.net`;
      socket.join(`chat-${normalized}`);
    });
  });

  // ... (rest of the server setup remains the same) ...

  process.on('SIGINT', async () => {
    try {
      await fastify.pg.query("UPDATE atendentes SET status = 'offline'");
      fastify.log.info('All atendentes set to offline on server shutdown');
    } finally {
      process.exit();
    }
  });

  const PORT = process.env.PORT || 3000;
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
