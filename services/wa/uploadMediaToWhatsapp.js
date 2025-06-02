import axios from 'axios'
import FormData from 'form-data'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config()

export async function uploadMediaToWhatsapp(fileUrl, type = 'image') {
  try {
    const response = await axios.get(fileUrl, { responseType: 'stream' })
    const fileName = path.basename(fileUrl)

    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('type', type)
    form.append('file', response.data, {
      filename: fileName,                        // 👈 Nome visível do arquivo
      contentType: response.headers['content-type'] || 'application/octet-stream' // 👈 Tipo MIME real
    })

    const res = await axios.post(
      `https://graph.facebook.com/v17.0/${process.env.PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
        }
      }
    )

    console.log('[✅ uploadMediaToWhatsapp] Enviado com sucesso:', res.data)
    return res.data.id
  } catch (err) {
    console.error('[❌ uploadMediaToWhatsapp] erro:', err.response?.data || err.message)
    throw new Error('Erro ao subir mídia para o WhatsApp')
  }
}
