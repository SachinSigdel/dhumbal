// Dhumbal online: a Cloudflare Worker plus one Durable Object per table.
//
//   POST /rooms                       {settings, id, name}  -> {code}   (create a table, you host it)
//   GET  /rooms/<CODE>                                       -> {exists, status, seats, players}
//   GET  /rooms/<CODE>/ws?id=…&name=…                        WebSocket for one player
//
// The Durable Object keeps the room in storage (so it survives being evicted) and uses
// WebSocket hibernation, so an idle table costs nothing while people think.

import { DurableObject } from 'cloudflare:workers';
import { Room, isValidCode, isValidId, newCode, validSettings } from './room.js';

const IDLE_MS = 24 * 60 * 60 * 1000;      // a table nobody is connected to is deleted after a day
const MAX_MESSAGE = 2048;
const MAX_MESSAGES = 100, MESSAGE_WINDOW_MS = 10000;  // per connection: far more than anyone can click

/** Per-IP rate limits (Cloudflare's rate-limiting bindings, see wrangler.jsonc); true if allowed. */
async function allowed(limiter, request, what) {
  if (!limiter) return true;                // not configured (e.g. in tests)
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  try { return (await limiter.limit({ key: `${what}:${ip}` })).success; } catch { return true; }
}
const tooMany = () => json({ error: 'Too many requests. Please wait a minute and try again.' }, 429);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...CORS },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'dhumbal' });

    if (url.pathname === '/rooms' && request.method === 'POST') {
      if (!(await allowed(env.CREATE_LIMITER, request, 'create'))) return tooMany();
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Bad request.' }, 400); }
      const settings = validSettings(body?.settings);
      if (!settings || !isValidId(body?.id)) return json({ error: 'Bad request.' }, 400);
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = newCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch('https://room/create', {
          method: 'POST', body: JSON.stringify({ code, settings, host: { id: body.id, name: body.name } }),
        });
        if (res.status === 200) return json({ code });
      }
      return json({ error: 'Could not create a table, please try again.' }, 503);
    }

    const match = url.pathname.match(/^\/rooms\/([A-Za-z0-9]+)(\/ws)?$/);
    if (match) {
      if (!(await allowed(env.JOIN_LIMITER, request, 'join'))) return tooMany();
      const code = match[1].toUpperCase();
      if (!isValidCode(code)) return json({ error: 'No table with that code.' }, 404);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      if (match[2]) {
        if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket.' }, 426);
        return stub.fetch(new Request(`https://room/ws${url.search}`, request));
      }
      return stub.fetch('https://room/info');
    }
    return json({ error: 'Not found.' }, 404);
  },
};

export class RoomObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // keep-alive: clients send "ping" every 25 s (idle sockets are closed after ~80 s); Cloudflare
    // answers "pong" itself without waking this object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.rates = new Map();    // socket -> recent message count (in memory only; fine to lose)
    ctx.blockConcurrencyWhile(async () => {
      this.data = (await ctx.storage.get('room')) ?? null;
      // after a restart (a deploy, or Cloudflare moving the object) the sockets that closed meanwhile
      // never reported it: anyone stored as connected without an open socket has dropped out
      const room = this.room();
      if (!room) return;
      const open = new Set(ctx.getWebSockets().map((ws) => ws.deserializeAttachment()?.id).filter(Boolean));
      const stale = room.members.filter((m) => m.connected && !open.has(m.id));
      if (!stale.length) return;
      for (const m of stale) room.disconnect(m.id);
      await this.commit(room);
    });
  }

  /** The room, built from a copy of the stored state (so a failed update leaves no half-changes). */
  room() { return this.data ? new Room(structuredClone(this.data)) : null; }

  /** Deliver the room's outbox, save it, and set the next alarm. */
  async commit(room) {
    const sockets = this.ctx.getWebSockets();
    for (const { to, msg } of room.outbox) {
      const text = JSON.stringify(msg);
      for (const ws of sockets) {
        if (ws.deserializeAttachment()?.id === to) { try { ws.send(text); } catch { /* closing */ } }
      }
    }
    room.outbox = [];
    const next = room.toJSON();
    if (JSON.stringify(next) === JSON.stringify(this.data)) return;   // nothing changed: no write
    this.data = next;
    await this.ctx.storage.put('room', this.data);
    const wake = room.nextWake(IDLE_MS);
    if (wake) await this.ctx.storage.setAlarm(wake);
    else await this.ctx.storage.deleteAlarm();
  }

  socketsOf(id) { return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.id === id); }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/create') {
      if (this.data) return new Response('taken', { status: 409 });
      const { code, settings, host } = await request.json();
      const room = Room.create(code, settings, host);
      await this.commit(room);
      return new Response('ok');
    }
    if (url.pathname === '/info') {
      const d = this.data;
      return json(d ? { exists: true, status: d.status, seats: d.members.length, players: d.settings.players }
        : { exists: false }, d ? 200 : 404);
    }
    if (url.pathname === '/ws') {
      const id = url.searchParams.get('id'), name = url.searchParams.get('name') ?? '';
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      const room = this.room();
      const problem = !room ? 'No table with that code (it may have expired).'
        : !isValidId(id) ? 'Bad player id.' : room.join(id, name);
      if (problem) {
        server.send(JSON.stringify({ type: 'error', fatal: true, message: problem }));
        server.close(4000, 'refused');
        return new Response(null, { status: 101, webSocket: client });
      }
      server.serializeAttachment({ id });
      room.connect(id);
      await this.commit(room);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws, raw) {
    const id = ws.deserializeAttachment()?.id;
    if (!id || typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
    const now = Date.now(), rate = this.rates.get(ws);
    if (!rate || now - rate.since > MESSAGE_WINDOW_MS) this.rates.set(ws, { since: now, count: 1 });
    else if (++rate.count > MAX_MESSAGES) {                            // flooding: refuse, cheaply
      if (rate.count === MAX_MESSAGES + 1) ws.send(JSON.stringify({ type: 'error', message: 'Too many messages: slow down a little.' }));
      return;
    }
    const room = this.room();
    if (!room) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    room.handle(id, msg);
    await this.commit(room);
    if (msg?.type === 'leave') {
      for (const s of this.socketsOf(id)) { try { s.close(1000, 'left'); } catch { /* gone */ } }
    }
  }

  async webSocketClose(ws) { await this.dropped(ws); }
  async webSocketError(ws) { await this.dropped(ws); }

  async dropped(ws) {
    const id = ws.deserializeAttachment()?.id;
    const room = this.room();
    if (!id || !room) return;
    // still here in another view (the popup and the side panel can both be open)?
    if (this.socketsOf(id).some((s) => s !== ws && s.readyState === WebSocket.OPEN)) return;
    room.disconnect(id);
    await this.commit(room);
  }

  async alarm() {
    const room = this.room();
    if (!room) return;
    const now = Date.now();
    room.tick(now);
    if (!room.connected.length && !room.data.botAt && now >= room.data.touchedAt + IDLE_MS) {
      await this.ctx.storage.deleteAll();
      this.data = null;
      return;
    }
    await this.commit(room);
  }
}
