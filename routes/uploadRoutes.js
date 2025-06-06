// routes/uploadRoutes.js
import multer from 'fastify-multer'
import { uploadToMinio } from '../services/uploadToMinio.js'

/** Configura o parser de multipart para Fastify */
const storage = multer.memoryStorage()
const upload = multer({ storage })

export default async function uploadRoutes(fastify) {
  fastify.register(multer.contentParser)

  fastify.post('/upload', { preHandler: upload.single('file') }, async (req, reply) => {
    const file = req.file
    if (!file) {
      return reply.code(400).send({ error: 'Arquivo ausente' })
    }

    try {
      const extension = file.mimetype.split('/')[1] || 'bin'
      const fileUrl = await uploadToMinio(file.buffer, file.originalname, extension)

      return reply.send({ url: fileUrl })
    } catch (err) {
      fastify.log.error('[uploadRoutes] Erro ao enviar para o MinIO:', err)
      return reply.code(500).send({ error: 'Falha ao fazer upload do arquivo' })
    }
  })
}
