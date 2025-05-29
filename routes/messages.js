import { sendWhatsappMessage } from '../services/sendWhatsappMessage.js';
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

export default async function messageRoutes(fastify, opts) {
  fastify.post("/send", async (req, reply) => {
  const { to, type, content } = req.body;

  try {
    const data = await sendWhatsappMessage({ to, type, content });
    reply.send(data);
  } catch (err) {
    const errorData = err.response?.data || err.message;
    fastify.log.error(errorData);

    if (
      errorData?.error?.message?.includes("outside the allowed window") ||
      errorData?.error?.code === 131047
    ) {
      reply.code(400).send({
        error: "Mensagem fora da janela de 24 horas. Envie um template aprovado.",
      });
    } else {
      reply.code(500).send("Erro ao enviar");
    }
  }
});


  fastify.post("/send/media", async (req, reply) => {
    const { to, mediaType, mediaUrl, caption } = req.body;

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: mediaType,
      [mediaType]: {
        link: mediaUrl,
        caption: caption || "",
      },
    };

    try {
      const res = await axios.post(
        "https://graph.facebook.com/v19.0/YOUR_PHONE_NUMBER_ID/messages",
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );
      reply.send(res.data);
    } catch (err) {
      fastify.log.error(err.response?.data || err.message);
      reply.code(500).send("Erro ao enviar mídia");
    }
  });

  fastify.post("/send/template", async (req, reply) => {
    const { to, templateName, languageCode, components } = req.body;

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
        "https://graph.facebook.com/v19.0/YOUR_PHONE_NUMBER_ID/messages",
        payload,
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );
      reply.send(res.data);
    } catch (err) {
      fastify.log.error(err.response?.data || err.message);
      reply.code(500).send("Erro ao enviar template");
    }
  });

  fastify.get("/templates", async (req, reply) => {
    try {
      const res = await axios.get(
        "https://graph.facebook.com/v19.0/YOUR_PHONE_NUMBER_ID/message_templates",
        {
          headers: {
            Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );
      reply.send(res.data);
    } catch (err) {
      fastify.log.error(err.response?.data || err.message);
      reply.code(500).send("Erro ao listar templates");
    }
  });
}
