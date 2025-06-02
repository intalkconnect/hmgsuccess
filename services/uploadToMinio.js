// services/uploadToMinio.js
import { minioClient } from './minioClient.js'
import path from 'path'
import { randomUUID } from 'crypto'

export async function uploadToMinio(fileBuffer, originalName, mimeType) {
  const extension = path.extname(originalName)
  const fileName = `${randomUUID()}${extension}`

  const metaData = {
    'Content-Type': mimeType
  }

  await minioClient.putObject(process.env.MINIO_BUCKET, fileName, fileBuffer, metaData)

  return `https://${process.env.MINIO_ENDPOINT}/${process.env.MINIO_BUCKET}/${fileName}`
}
