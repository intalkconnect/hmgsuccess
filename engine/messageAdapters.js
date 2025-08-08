// engine/messageAdapters.js

import { MESSAGE_TYPES, CHANNELS } from './messageTypes.js';

export class MessageAdapter {
  static toWhatsapp(unifiedMessage) {
    switch (unifiedMessage.type) {
      case MESSAGE_TYPES.TEXT:
        return { body: unifiedMessage.content.text };
      case MESSAGE_TYPES.IMAGE:
        return {
          link: unifiedMessage.content.url,
          caption: unifiedMessage.content.caption
        };
      case MESSAGE_TYPES.AUDIO:
        return {
          link: unifiedMessage.content.url,
          voice: unifiedMessage.content.isVoice || false
        };
      case MESSAGE_TYPES.VIDEO:
        return {
          link: unifiedMessage.content.url,
          caption: unifiedMessage.content.caption
        };
      case MESSAGE_TYPES.DOCUMENT:
        return {
          link: unifiedMessage.content.url,
          filename: unifiedMessage.content.filename
        };
      case MESSAGE_TYPES.LOCATION:
        return {
          latitude: unifiedMessage.content.latitude,
          longitude: unifiedMessage.content.longitude,
          name: unifiedMessage.content.name,
          address: unifiedMessage.content.address
        };
      case MESSAGE_TYPES.INTERACTIVE:
        return unifiedMessage.content;
      default:
        throw new Error(`Tipo de mensagem não suportado: ${unifiedMessage.type}`);
    }
  }

  static toTelegram(unifiedMessage) {
    switch (unifiedMessage.type) {
      case MESSAGE_TYPES.TEXT:
        return { text: unifiedMessage.content.text };
      case MESSAGE_TYPES.IMAGE:
        return {
          photo: unifiedMessage.content.url,
          caption: unifiedMessage.content.caption
        };
      case MESSAGE_TYPES.AUDIO:
        return {
          audio: unifiedMessage.content.url,
          voice: unifiedMessage.content.isVoice || false
        };
      case MESSAGE_TYPES.VIDEO:
        return {
          video: unifiedMessage.content.url,
          caption: unifiedMessage.content.caption
        };
      case MESSAGE_TYPES.DOCUMENT:
        return {
          document: unifiedMessage.content.url,
          filename: unifiedMessage.content.filename
        };
      case MESSAGE_TYPES.LOCATION:
        return {
          latitude: unifiedMessage.content.latitude,
          longitude: unifiedMessage.content.longitude
        };
      case MESSAGE_TYPES.INTERACTIVE:
        return this._adaptInteractiveToTelegram(unifiedMessage.content);
      default:
        throw new Error(`Tipo de mensagem não suportado: ${unifiedMessage.type}`);
    }
  }

  static _adaptInteractiveToTelegram(content) {
    if (content.buttons) {
      return {
        reply_markup: {
          inline_keyboard: content.buttons.map(btn => [{ text: btn.title, callback_data: btn.id }])
        }
      };
    }
    if (content.list) {
      // Adaptação para listas do Telegram
      return {
        reply_markup: {
          keyboard: content.list.sections.map(section => 
            section.rows.map(row => ({ text: row.title }))
          ),
          one_time_keyboard: true
        }
      };
    }
    return content;
  }
}
