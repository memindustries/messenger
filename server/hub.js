import { WebSocketServer } from 'ws';

const MSG_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_CT = 24 * 1024;
const MAX_ROOM_TEXT = 2000;

export function validEnvelope(env) {
  return env && typeof env === 'object' && env.v === 1
    && typeof env.salt === 'string' && env.salt.length === 24 && B64_RE.test(env.salt)
    && typeof env.iv === 'string' && env.iv.length === 16 && B64_RE.test(env.iv)
    && typeof env.ct === 'string' && env.ct.length <= MAX_CT && B64_RE.test(env.ct);
}

// Relays end-to-end encrypted messages and presence between mutual buddies.
// The server only ever sees ciphertext; presence and away state live in memory.
export class Hub {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
    this.conns = new Map(); // userId -> Set<ws>
    this.status = new Map(); // userId -> { away, awayMessage }
  }

  attach(server, { sessionFromReq, originAllowed }) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const reject = (code, text) => {
        socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };
      if (new URL(req.url, 'http://localhost').pathname !== '/ws') return reject(404, 'Not Found');
      // Browsers always send Origin on WebSocket handshakes; this blocks
      // cross-site WebSocket hijacking.
      if (!originAllowed(req)) return reject(403, 'Forbidden');
      const session = sessionFromReq(req);
      if (!session) return reject(401, 'Unauthorized');
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, session));
    });
    this.pingTimer = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!ws.alive) {
          ws.terminate();
          continue;
        }
        ws.alive = false;
        ws.ping();
      }
    }, 30_000);
    this.pingTimer.unref();
  }

  close() {
    clearInterval(this.pingTimer);
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
  }

  isOnline(userId) {
    return (this.conns.get(userId)?.size ?? 0) > 0;
  }

  presenceOf(userId) {
    const online = this.isOnline(userId);
    const st = this.status.get(userId);
    return {
      online,
      away: online && !!st?.away,
      awayMessage: online && st?.away ? st.awayMessage : '',
    };
  }

  send(userId, msg) {
    const set = this.conns.get(userId);
    if (!set) return false;
    const data = JSON.stringify(msg);
    for (const ws of set) ws.send(data);
    return set.size > 0;
  }

  broadcastPresence(user) {
    const msg = { t: 'presence', screenName: user.display, ...this.presenceOf(user.id) };
    for (const id of this.store.buddyIds(user.id)) this.send(id, msg);
  }

  // Send to every signed-on member of a room.
  sendRoom(roomId, msg, exceptUserId) {
    const data = JSON.stringify(msg);
    for (const id of this.store.roomMemberIds(roomId)) {
      if (id === exceptUserId) continue;
      for (const ws of this.conns.get(id) ?? []) ws.send(data);
    }
  }

  roomOnlineCount(roomId) {
    return this.store.roomMemberIds(roomId).filter((id) => this.isOnline(id)).length;
  }

  // "X has entered/left the room" when someone signs on or off.
  broadcastRoomPresence(user, online) {
    for (const room of this.store.userRooms(user.id)) {
      if (room.status === 'member') this.sendRoom(room.id, { t: 'roomPresence', room: room.id, screenName: user.display, online }, user.id);
    }
  }

  disconnectSession(tokenHash) {
    for (const ws of this.wss?.clients ?? []) if (ws.tokenHash === tokenHash) ws.close(4001, 'Signed off');
  }

  disconnectUser(userId, exceptTokenHash) {
    for (const ws of this.conns.get(userId) ?? []) {
      if (ws.tokenHash !== exceptTokenHash) ws.close(4001, 'Signed off');
    }
  }

  onConnection(ws, session) {
    const user = session.user;
    ws.alive = true;
    ws.tokenHash = session.tokenHash;
    ws.bucket = { tokens: 30, last: Date.now() };
    ws.on('pong', () => { ws.alive = true; });

    let set = this.conns.get(user.id);
    if (!set) this.conns.set(user.id, (set = new Set()));
    const firstConnection = set.size === 0;
    set.add(ws);
    if (firstConnection) {
      this.status.set(user.id, { away: false, awayMessage: '' });
      this.broadcastPresence(user);
      this.broadcastRoomPresence(user, true);
    }

    ws.send(JSON.stringify({ t: 'hello', screenName: user.display }));
    for (const m of this.store.offlineFor(user.id)) {
      ws.send(JSON.stringify({ t: 'im', from: m.from_display, id: m.msg_id, env: JSON.parse(m.envelope), oid: m.id, offline: true }));
    }

    ws.on('message', (raw, isBinary) => {
      if (isBinary || !this.allow(ws)) return ws.close(1008, 'Slow down');
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      // Re-check the session on every message so revocation takes effect.
      const fresh = this.store.userById(user.id);
      if (!fresh) return ws.close(4001, 'Account removed');
      try {
        this.onMessage(ws, fresh, msg);
      } catch (err) {
        console.error('ws message error', err);
      }
    });

    ws.on('close', () => {
      set.delete(ws);
      if (set.size === 0) {
        this.conns.delete(user.id);
        this.status.delete(user.id);
        if (this.store.userById(user.id)) {
          this.broadcastPresence(user);
          this.broadcastRoomPresence(user, false);
        }
      }
    });
  }

  // Token bucket: ~10 messages/second sustained, bursts of 30.
  allow(ws) {
    const now = Date.now();
    const b = ws.bucket;
    b.tokens = Math.min(30, b.tokens + ((now - b.last) / 1000) * 10);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  onMessage(ws, me, msg) {
    const reply = (m) => ws.send(JSON.stringify(m));
    switch (msg.t) {
      case 'im': {
        const id = typeof msg.id === 'string' && MSG_ID_RE.test(msg.id) ? msg.id : null;
        if (!id) return;
        const to = typeof msg.to === 'string' ? this.store.userByName(msg.to) : null;
        if (!to || !this.store.areBuddies(me.id, to.id)) {
          return reply({ t: 'error', id, error: 'You can only message people on your Buddy List.' });
        }
        if (!validEnvelope(msg.env)) return reply({ t: 'error', id, error: 'Malformed message.' });
        const env = { v: 1, salt: msg.env.salt, iv: msg.env.iv, ct: msg.env.ct };
        if (this.send(to.id, { t: 'im', from: me.display, id, env })) {
          return reply({ t: 'sent', id });
        }
        if (this.config.offlineTtlMs > 0
            && this.store.queueOffline(to.id, me.id, id, JSON.stringify(env), this.config.offlineTtlMs, this.config.maxOfflinePerUser)) {
          return reply({ t: 'sent', id, queued: true });
        }
        return reply({ t: 'error', id, error: `${to.display} is offline and can't receive messages right now.` });
      }
      case 'room': {
        const id = typeof msg.id === 'string' && MSG_ID_RE.test(msg.id) ? msg.id : null;
        if (!id) return;
        const room = Number.isInteger(msg.room) ? this.store.room(msg.room) : null;
        if (!room || this.store.membership(room.id, me.id)?.status !== 'member') {
          return reply({ t: 'error', id, room: msg.room, error: "You're not in that room." });
        }
        if (room.kind === 'public') {
          // Public rooms are protected by HTTPS only; relayed live, never stored.
          const text = typeof msg.text === 'string' ? msg.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '';
          if (!text || text.length > MAX_ROOM_TEXT) return reply({ t: 'error', id, room: room.id, error: 'Message is empty or too long.' });
          this.sendRoom(room.id, { t: 'room', room: room.id, from: me.display, id, text, ts: Date.now() }, me.id);
          return reply({ t: 'sent', id, room: room.id });
        }
        if (!validEnvelope(msg.env)) return reply({ t: 'error', id, room: room.id, error: 'Malformed message.' });
        if (msg.epoch !== room.key_epoch) {
          return reply({ t: 'error', id, room: room.id, rekey: true, error: 'The room key changed; message not sent. Try again.' });
        }
        const env = { v: 1, salt: msg.env.salt, iv: msg.env.iv, ct: msg.env.ct };
        this.sendRoom(room.id, { t: 'room', room: room.id, from: me.display, id, epoch: room.key_epoch, env }, me.id);
        return reply({ t: 'sent', id, room: room.id });
      }
      case 'delivered': {
        if (!Array.isArray(msg.oids)) return;
        for (const oid of msg.oids.slice(0, 500)) if (Number.isInteger(oid)) this.store.deleteOffline(oid, me.id);
        return;
      }
      case 'typing': {
        const to = typeof msg.to === 'string' ? this.store.userByName(msg.to) : null;
        if (to && this.store.areBuddies(me.id, to.id)) {
          this.send(to.id, { t: 'typing', from: me.display, on: msg.on === true });
        }
        return;
      }
      case 'status': {
        const away = msg.away === true;
        const awayMessage = away && typeof msg.awayMessage === 'string' ? msg.awayMessage.slice(0, 500) : '';
        this.status.set(me.id, { away, awayMessage });
        return this.broadcastPresence(me);
      }
      default:
    }
  }
}
