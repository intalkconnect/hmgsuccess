// routes/uploadRoutes.js
import { uploadToMinio } from '../services/uploadToMinio.js'

export default async function uploadRoutes(fastify) {
  fastify.post('/upload', async (req, reply) => {
    const file = await req.file()

    if (!file) {
      return reply.code(400).send({ error: 'Nenhum arquivo enviado.' })
    }

    const buffer = await file.toBuffer()
    const fileUrl = await uploadToMinio(buffer, file.filename, file.mimetype)

    return { url: fileUrl }
  })
}
