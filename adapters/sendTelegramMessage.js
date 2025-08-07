import axios from 'axios'

export async function sendTelegramMessage({ to, type, content }) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (type === 'text') {
    return axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: to,
      text: content.body
    })
  }
  // Adicione outros tipos se precisar
  return null
}
