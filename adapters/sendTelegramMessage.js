import axios from 'axios';

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;

export async function sendTelegramMessage(to, content, context = null, type = 'text') {
  try {
    // 🔘 Trata mensagens interativas com botões
    if (type === 'interactive') {
      const text = content?.body?.text || 'Escolha uma opção';
      const buttons = content?.action?.buttons || [];

      const inlineKeyboard = buttons.map(button => [
        {
          text: button.reply?.title || 'Opção',
          callback_data: button.reply?.id || button.reply?.title
        }
      ]);

      const payload = {
        chat_id: to,
        text,
        reply_markup: {
          inline_keyboard: inlineKeyboard
        }
      };

      const res = await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
      return res.data;
    }

    // 📝 Texto simples
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const res = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: to,
      text
    });

    return res.data;

  } catch (err) {
    console.error('❌ Erro ao enviar mensagem Telegram:', err.response?.data || err.message);
    throw err;
  }
}
