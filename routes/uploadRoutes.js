export async function uploadToMinio(buffer, originalname, mimetype) {
  const ext = path.extname(originalname)
  const uniqueName = `${uuidv4()}${ext}`
  const bucket = process.env.MINIO_BUCKET

  console.log('[🟡 uploadToMinio] Iniciando upload', {
    bucket,
    originalname,
    uniqueName,
    mimetype
  })

  try {
    await minioClient.putObject(bucket, uniqueName, buffer, {
      'Content-Type': mimetype
    })

    const publicUrl = `https://${process.env.MINIO_ENDPOINT}/${bucket}/${uniqueName}`
    console.log('[✅ Upload concluído]', publicUrl)

    return publicUrl
  } catch (err) {
    console.error('❌ Erro ao enviar para o MinIO:', err)
    throw new Error('Falha ao fazer upload do arquivo')
  }
}
