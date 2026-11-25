// The connection to the Dhumbal server for playing with friends (see server/).
// The server deals and keeps the hands; this only sends your moves and passes what it hears
// back to the table (app.js), which animates it.

export const DEFAULT_SERVER = 'https://dhumbal.dhumbal-server.workers.dev';

const RETRY_MS = [500, 1000, 2000, 4000, 8000];
const PING_MS = 25000;            // the server's host closes sockets that are quiet for ~80 s
const DEAD_MS = 65000;            // no answer at all for this long (2+ pings): the connection is dead

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class OnlineClient {
  /** `store` is the app's localStorage helper; `handlers` get the server's messages. */
  constructor(store, handlers) {
    this.store = store;
    this.handlers = handlers;
    this.server = (store.get('server', null) || DEFAULT_SERVER).replace(/\/$/, '');
    this.id = store.get('playerId', null);
    if (!this.id) { this.id = randomId(); store.set('playerId', this.id); }
    this.ws = null;
    this.code = null;
    this.retries = 0;
    this.closing = false;
    this.connected = false;
  }

  get name() { return this.store.get('name', ''); }

  /** Create a table with these rules and sit down at it as the host. */
  async create(settings, name) {
    let res;
    try {
      res = await fetch(`${this.server}/rooms`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings, id: this.id, name }),
      });
    } catch {
      throw new Error("Couldn't reach the Dhumbal server. Check your connection and try again.");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.code) throw new Error(body.error || 'Could not create a table.');
    this.join(body.code, name);
    return body.code;
  }

  join(code, name) {
    this.code = code.toUpperCase();
    this.store.set('online', { code: this.code });
    this.closing = false;
    this.retries = 0;
    this.open(name);
  }

  /** Reconnect to the table saved from last time (the toolbar popup closes whenever you click away). */
  resume() {
    const saved = this.store.get('online', null);
    if (!saved?.code) return false;
    this.join(saved.code, this.name);
    return true;
  }

  open(name = this.name) {
    const url = `${this.server.replace(/^http/, 'ws')}/rooms/${this.code}/ws?id=${this.id}&name=${encodeURIComponent(name)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retries = 0;
      clearInterval(this.pingTimer);
      this.lastHeard = Date.now();
      this.pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - this.lastHeard > DEAD_MS) { this.dropped(ws); return; }   // e.g. after the laptop slept
        ws.send('ping');
      }, PING_MS);
      this.handlers.onStatus?.('connected');
    };
    ws.onmessage = (e) => {
      this.lastHeard = Date.now();
      if (e.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'error' && msg.fatal) {
        this.forget();
        this.handlers.onFatal?.(msg.message);
        return;
      }
      this.handlers.onMessage(msg);
    };
    ws.onclose = () => this.dropped(ws);
  }

  /** The connection `ws` is gone (or silently dead): reconnect, a little slower each time. */
  dropped(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    try { ws.close(); } catch { /* already closed */ }
    this.connected = false;
    clearInterval(this.pingTimer);
    if (this.closing || !this.code) return;
    // try again, a little slower each time (a bot plays for you meanwhile)
    const delay = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)];
    this.retries += 1;
    this.handlers.onStatus?.('reconnecting');
    this.retryTimer = setTimeout(() => { if (!this.closing && this.code) this.open(); }, delay);
  }

  send(msg) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Stop playing at this table (a bot finishes your game for you). */
  leave() {
    this.send({ type: 'leave' });
    this.forget();
  }

  forget() {
    this.closing = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.store.set('online', null);
    this.code = null;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    try { ws?.close(); } catch { /* already closed */ }
  }
}
