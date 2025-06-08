// src/routes/webhook.js
import dotenv from "dotenv";
import { pool } from "../services/db.js";

import { runFlow } from "../chatbot/flowExecutor.js";
import { markMessageAsRead } from "../services/wa/markMessageAsRead.js";

import axios from "axios";
import { uploadToMinio } from "../services/uploadToMinio.js";

dotenv.config();

export default async function webhookRoutes(fastify) {
  const io = fastify.io;

  fastify.get("/", async (req, reply) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token === process.env.VERIFY_TOKEN) {
      return reply.code(200).send(challenge);
    }
    return reply.code(403).send("Forbidden");
  });

  fastify.post("/", async (req, reply) => {
    const body = req.body;

    const hasStatusesOnly = !!body.entry?.[0]?.changes?.[0]?.value?.statuses;
    const hasMessages = !!body.entry?.[0]?.changes?.[0]?.value?.messages;

    if (!hasMessages || hasStatusesOnly) {
      return reply.code(200).send("EVENT_RECEIVED");
    }

    const entry = body.entry[0].changes[0].value;
    const messages = entry.messages;
    const contact = entry.contacts?.[0];
    const from = contact?.wa_id;
    const profileName = contact?.profile?.name || "usuário";

    if (messages && messages.length > 0 && from) {
      const msg = messages[0];
      const msgId = msg.id;
      const msgType = msg.type;

      let content = null;
      let userMessage = "";

      if (["image", "video", "audio", "document"].includes(msgType)) {
        try {
          const mediaId = msg[msgType]?.id;

          const mediaUrlRes = await axios.get(
            `https://graph.facebook.com/v19.0/${mediaId}`,
            {
              headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
              },
            }
          );

          const mediaUrl = mediaUrlRes.data.url;
          const mimeType = msg[msgType]?.mime_type || "application/octet-stream";

          const mediaRes = await axios.get(mediaUrl, {
            responseType: "arraybuffer",
            headers: {
              Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            },
          });

          const fileBuffer = mediaRes.data;
          const extension = mimeType.split("/")[1] || "bin";

          const uploadedUrl = await uploadToMinio(
            fileBuffer,
            `${msgType}-${mediaId}.${extension}`,
            mimeType
          );

          if (msgType === "audio") {
            content = JSON.stringify({ url: uploadedUrl });
            userMessage = "[áudio recebido]";
          } else {
            const filename = `${msgType}.${extension}`;
            content = JSON.stringify({
              url: uploadedUrl,
              filename,
              caption: msg.caption || filename,
            });
            userMessage = `[${msgType} recebido]`;
          }
        } catch (err) {
          console.error(`❌ Erro ao tratar mídia do tipo ${msgType}:`, err);
          userMessage = `[${msgType} recebido - erro ao processar]`;
          content = userMessage;
        }
      } else {
        switch (msgType) {
          case "text":
            userMessage = msg.text?.body || "";
            content = userMessage;
            break;
          case "interactive":
            userMessage =
              msg.interactive?.button_reply?.id ||
              msg.interactive?.list_reply?.id ||
              "";
            content = userMessage;
            break;
          case "location":
            const { latitude, longitude } = msg.location || {};
            userMessage = `📍 Localização recebida: ${latitude}, ${longitude}`;
            content = userMessage;
            break;
          default:
            userMessage = `[tipo não tratado: ${msgType}]`;
            content = userMessage;
        }
      }

      const { rows: latestFlowRows } = await pool.query(
        "SELECT * FROM flows WHERE active = TRUE LIMIT 1"
      );
      const latestFlow = latestFlowRows[0] || null;

      const formattedUserId = `${from}@w.msgcli.net`;

      // Verifica se cliente já existe
      const { rows: existingClientRows } = await pool.query(
        "SELECT id FROM clientes WHERE phone = $1 LIMIT 1",
        [from]
      );
      const existingClient = existingClientRows[0] || null;

      if (!existingClient) {
        try {
          await pool.query(
            `INSERT INTO clientes (phone, name, channel, user_id, create_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [from, profileName, "whatsapp", formattedUserId, new Date().toISOString()]
          );
          console.log("✅ Cliente salvo:", from);
        } catch (insertErr) {
          console.error("❌ Erro ao salvar cliente:", insertErr);
        }
      }

      const vars = {
        userPhone: from,
        userName: profileName,
        lastUserMessage: userMessage,
        channel: "whatsapp",
        now: new Date().toISOString(),
        lastMessageId: msgId,
      };

      markMessageAsRead(msgId);

      let insertedMessages = [];
      try {
        const insertRes = await pool.query(
          `INSERT INTO messages (
            user_id, whatsapp_message_id, direction, type, content, timestamp, flow_id,
            reply_to, status, metadata, created_at, updated_at, channel
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13
          )
          RETURNING *`,
          [
            formattedUserId,
            msgId,
            "incoming",
            msgType,
            content,
            new Date().toISOString(),
            latestFlow?.id || null,
            msg.context?.id || null,
            "received",
            null,
            new Date().toISOString(),
            new Date().toISOString(),
            "whatsapp",
          ]
        );
        insertedMessages = insertRes.rows;
      } catch (err) {
        console.error("❌ Erro ao gravar mensagem:", err);
      }

      if (insertedMessages?.[0]) {
        const emitPayload = insertedMessages[0];
        setTimeout(() => {
          io.emit("new_message", emitPayload);
          io.to(`chat-${formattedUserId}`).emit("new_message", emitPayload);
        }, 200);
      }

      // Emit bot status
      if (io) {
        const statusPayload = {
          user_id: formattedUserId,
          status: "processing",
        };
        io.emit("bot_processing", statusPayload);
        io.to(`chat-${formattedUserId}`).emit("bot_processing", statusPayload);
      }

      // Executa o fluxo
      const outgoingMessage = await runFlow({
        message: userMessage.toLowerCase(),
        flow: latestFlow?.data,
        vars,
        rawUserId: from,
        io,
      });

      if (io && outgoingMessage?.user_id) {
        io.emit("new_message", outgoingMessage);
        io.to(`chat-${formattedUserId}`).emit("new_message", outgoingMessage);
      } else {
        console.warn("⚠️ botResponse não foi emitido:", outgoingMessage);
      }
    }

    return reply.code(200).send("EVENT_RECEIVED");
  });
}
