// routes/uploadRoutes.js
import multer from 'fastify-multer'
import { uploadToMinio } from '../services/uploadToMinio.js'

export default async function uploadRoutes(fastify) {
  fastify.register(multer.contentParser)

  fastify.post('/upload', {
    preHandler: multer().single('file'),
    handler: async (req, reply) => {
      const file = req.file
      if (!file) {
        return reply.code(400).send({ error: 'Arquivo ausente' })
      }

      const fileUrl = await uploadToMinio(file.buffer, file.originalname, file.mimetype)
      return { url: fileUrl }
    }
  })
}
