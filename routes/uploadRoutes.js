// src/routes/uploadRoutes.js
import multer from 'fastify-multer'
import { uploadToMinio } from '../services/uploadToMinio.js'

export default async function uploadRoutes(fastify) {
  fastify.register(multer.contentParser)

  fastify.post('/upload', multer().single('file'), async (req, reply) => {
    const file = req.file
    if (!file) return reply.code(400).send({ error: 'Arquivo ausente' })

    try {
      const fileUrl = await uploadToMinio(file.buffer, file.originalname, file.mimetype)
      return { url: fileUrl }
    } catch (err) {
      fastify.log.error('Erro ao subir para MinIO:', err)
      return reply.code(500).send({ error: 'Falha ao subir arquivo' })
    }
  })
}
