// services/sendWebchatMessage.js

export async function sendWebchatMessage({ to, content }) {
  console.log(`📤 [webchat] Enviando mensagem para ${to}:`, content);
  // Aqui você pode integrar com um WebSocket, API REST, etc.
  // Por enquanto, é apenas um stub para evitar erros.
  return { success: true };
}
