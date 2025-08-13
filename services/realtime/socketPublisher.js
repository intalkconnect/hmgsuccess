// realtime/socketPublisher.js
const { io } = require('socket.io-client');

class SocketPublisher {
  constructor({ url, key, namespace = '/', extraAuth = {} }) {
    this.socket = io(url + namespace, {
      transports: ['websocket'],          // evita long-polling
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelayMax: 5000,
      auth: { key, role: 'publisher', ...extraAuth }, // se o server checar auth
    });

    this.socket.on('connect', () => {
      console.log('[socket.pub] conectado', this.socket.id);
    });
    this.socket.on('connect_error', (err) => {
      console.error('[socket.pub] connect_error:', err.message);
    });
    this.socket.on('error', (err) => {
      console.error('[socket.pub] error:', err);
    });
  }

  /**
   * Publica um evento para uma room.
   * Convenciona-se:
   *  - room: tenant:{tenantId}:atendimento:{atendimentoId}
   *  - event: "nova_mensagem"
   *  - payload: dados mínimos p/ UI
   */
  publishToRoom(room, event, payload) {
    // DUAS OPÇÕES (escolha conforme teu server7):
    // A) server7 expõe um evento "pub" que ele reemite na room:
    this.socket.emit('pub', { room, event, payload });

    // B) OU, se o server7 deixa o próprio client emitir pra uma room conhecida,
    //    pode haver um evento específico "nova_mensagem" com {room, payload}:
    // this.socket.emit('nova_mensagem', { room, payload });
  }
}

let singleton;
function getPublisher() {
  if (!singleton) {
    singleton = new SocketPublisher({
      url: process.env.SRWS_URL,       // ex.: "wss://server7.exemplo.com"
      key: process.env.SRWS_PUB_KEY,   // se existir validação
      // namespace: '/atendimento',    // se usar namespace
    });
  }
  return singleton;
}

module.exports = { getPublisher };
