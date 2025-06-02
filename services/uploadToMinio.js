// src/services/uploadToMinio.js
import { Client } from 'minio'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config()

const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT.replace(/^https?:\/\//, ''),
  port: 443,
  useSSL: true,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY
})

export async function uploadToMinio(buffer, originalname, mimetype) {
  const ext = path.extname(originalname)
  const uniqueName = `${uuidv4()}${ext}`
  const bucket = process.env.MINIO_BUCKET

  try {
    await minioClient.putObject(bucket, uniqueName, buffer, {
      'Content-Type': mimetype
    })

    return `https://${process.env.MINIO_ENDPOINT}/${bucket}/${uniqueName}`
  } catch (err) {
    console.error('❌ Erro ao enviar para o MinIO:', err)
    throw new Error('Falha ao fazer upload do arquivo')
  }
}
