// src/routes/messageRoutes.js

import dotenv from "dotenv";
import { pool } from "../services/db.js";
import { sendWhatsappMessage } from "../services/sendWhatsappMessage.js";
import axios from "axios";

dotenv.config();

export default async function messageRoutes(fastify, opts) {
  // ─────────────────────────────────────────────
  // 1) Envia qualquer tipo de mensagem (text, image, etc.)
  // ─────────────────────────────────────────────
  fastify.post("/send", async (req, reply) => {
    const { to, type, content, context } = req.body;
    const userId = `${to}@w.msgcli.net`;

    try {
      const result = await sendWhatsappMessage({ to, type, content, context });
      const whatsappMsgId = result.messages?.[0]?.id || null;

      const outgoingMsg = {
        user_id: userId,
        whatsapp_message_id: whatsappMsgId,
        direction: "outgoing",
        type,
        content:
          type === "text" && typeof content === "object" && content.body
            ? content.body
            : JSON.stringify(content),
        timestamp: new Date().toISOString(),
        flow_id: null,
        reply_to: context?.message_id || null,
        status: "sent",
        metadata: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        channel: "whatsapp",
      };

      const insertRes = await pool.query(
        `INSERT INTO messages (
          user_id, whatsapp_message_id, direction, type, content,
          timestamp, flow_id, reply_to, status, metadata,
          created_at, updated_at, channel
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13
        ) RETURNING *`,
        [
          outgoingMsg.user_id,
          outgoingMsg.whatsapp_message_id,
          outgoingMsg.direction,
          outgoingMsg.type,
          outgoingMsg.content,
          outgoingMsg.timestamp,
          outgoingMsg.flow_id,
          outgoingMsg.reply_to,
          outgoingMsg.status,
          outgoingMsg.metadata,
          outgoingMsg.created_at,
          outgoingMsg.updated_at,
          outgoingMsg.channel,
        ]
      );

      const mensagemInserida = insertRes.rows[0];

      if (fastify.io) {
        fastify.io.emit("new_message", mensagemInserida);
        fastify.io.to(`chat-${mensagemInserida.user_id}`).emit("new_message", mensagemInserida);
      }

      return reply.code(200).send(result);
    } catch (err) {
      const errorData = err.response?.data || err.message;

      if (
        errorData?.error?.message?.includes("outside the allowed window") ||
        errorData?.error?.code === 131047
      ) {
        return reply.code(400).send({
          error: "Mensagem fora da janela de 24 horas. Envie um template aprovado.",
        });
      }

      return reply.code(500).send({ error: "Erro ao enviar mensagem" });
    }
  });

  // ─────────────────────────────────────────────
  // 2) Envia mensagem template
  // ─────────────────────────────────────────────
  fastify.post("/send/template", async (req, reply) => {
    const { to, templateName, languageCode, components } = req.body;
    const userId = `${to}@w.msgcli.net`;

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components: components || [],
      },
    };

    try {
      const res = await axios.post(
        `https://graph.facebook.com/${process.env.API_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      const whatsappMsgId = res.data.messages?.[0]?.id || null;

      const outgoingMsg = {
        user_id: userId,
        whatsapp_message_id: whatsappMsgId,
        direction: "outgoing",
        type: "template",
        content: templateName,
        timestamp: new Date().toISOString(),
        flow_id: null,
        agent_id: null,
        queue_id: null,
        status: "sent",
        metadata: JSON.stringify({ languageCode, components }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        channel: "whatsapp",
      };

      const insertRes = await pool.query(
        `INSERT INTO messages (
          user_id, whatsapp_message_id, direction, type, content,
          timestamp, flow_id, agent_id, queue_id, status, metadata,
          created_at, updated_at, channel
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10, $11,
          $12, $13, $14
        ) RETURNING *`,
        [
          outgoingMsg.user_id,
          outgoingMsg.whatsapp_message_id,
          outgoingMsg.direction,
          outgoingMsg.type,
          outgoingMsg.content,
          outgoingMsg.timestamp,
          outgoingMsg.flow_id,
          outgoingMsg.agent_id,
          outgoingMsg.queue_id,
          outgoingMsg.status,
          outgoingMsg.metadata,
          outgoingMsg.created_at,
          outgoingMsg.updated_at,
          outgoingMsg.channel,
        ]
      );

      const mensagemInserida = insertRes.rows[0];

      if (fastify.io) {
        fastify.io.emit("new_message", mensagemInserida);
        fastify.io.to(`chat-${mensagemInserida.user_id}`).emit("new_message", mensagemInserida);
      }

      return reply.code(200).send(res.data);
    } catch (err) {
      fastify.log.error("[messageRoutes] Erro ao enviar template:", err.response?.data || err.message);
      return reply.code(500).send({ error: "Erro ao enviar template" });
    }
  });

  // ─────────────────────────────────────────────
  // 3) Lista templates
  // ─────────────────────────────────────────────
  fastify.get("/templates", async (req, reply) => {
    try {
      const res = await axios.get(
        `https://graph.facebook.com/${process.env.API_VERSION}/${process.env.WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates`,
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );
      return reply.code(200).send(res.data);
    } catch (err) {
      fastify.log.error("[messageRoutes] Erro ao listar templates:", err.response?.data || err.message);
      return reply.code(500).send({ error: "Erro ao listar templates" });
    }
  });

  // ─────────────────────────────────────────────
  // 4) Lista mensagens de um usuário
  // ─────────────────────────────────────────────
  fastify.get("/:user_id", async (req, reply) => {
    const { user_id } = req.params;
    try {
      const { rows } = await pool.query(
        "SELECT * FROM messages WHERE user_id = $1 ORDER BY timestamp ASC",
        [user_id]
      );
      return reply.code(200).send(rows);
    } catch (err) {
      console.error("Erro ao buscar mensagens:", err);
      return reply.status(500).send({ error: "Erro interno ao buscar mensagens" });
    }
  });
}
