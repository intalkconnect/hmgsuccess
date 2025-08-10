// Um único cliente PG que faz LISTEN e reemite eventos em memória
import pg from 'pg';
import { EventEmitter } from 'events';

class PgBus extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.listening = new Set();       // canais ativos
    this.refCount  = new Map();       // canal -> nº de conexões SSE
    this._ready = this._init();
  }

  async _init() {
    if (this.client) {
      try { this.client.removeAllListeners(); await this.client.end(); } catch {}
    }
    this.client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await this.client.connect();

    this.client.on('notification', (msg) => {
      let payload;
      try {
        payload = msg.payload ? JSON.parse(msg.payload) : {};
      } catch {
        payload = { payload: msg.payload };
      }
      // Reemite por canal específico e um curinga
      this.emit(msg.channel, { channel: msg.channel, ...payload });
      this.emit('*',           { channel: msg.channel, ...payload });
    });

    // Em caso de erro, tenta religar mantendo os canais
    this.client.on('error', (err) => {
      console.error('[pgBus] client error, reconnecting soon:', err?.message);
      setTimeout(() => this._init().catch(e => console.error('[pgBus] reinit fail', e)), 800);
    });

    // Reinscreve nos canais que já estávamos ouvindo
    for (const ch of this.listening) {
      try { await this.client.query(`LISTEN "${ch}"`); } catch (e) { console.error('[pgBus] re-LISTEN fail', ch, e?.message); }
    }
  }

  async ready() { return this._ready; }

  async listen(channel) {
    await this.ready();
    const name = String(channel);
    const n = (this.refCount.get(name) || 0) + 1;
    this.refCount.set(name, n);
    if (n === 1) {
      await this.client.query(`LISTEN "${name}"`);
      this.listening.add(name);
    }
  }

  async unlisten(channel) {
    await this.ready();
    const name = String(channel);
    const n = (this.refCount.get(name) || 0) - 1;
    if (n > 0) { this.refCount.set(name, n); return; }
    this.refCount.delete(name);
    if (this.listening.has(name)) {
      await this.client.query(`UNLISTEN "${name}"`);
      this.listening.delete(name);
    }
  }
}

export const pgBus = new PgBus();
