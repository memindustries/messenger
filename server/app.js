import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Hub } from './hub.js';
import {
  createStore, hashAuthKey, verifyAuthKey, normalizeScreenName, normalizeInvite, sha256,
} from './store.js';

const SCREEN_NAME_RE = /^[A-Za-z][A-Za-z0-9]*( [A-Za-z0-9]+)*$/;
const AUTH_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const GROUP_RE = /^[\p{L}\p{N} '&._-]{1,24}$/u;
const MAX_BODY = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers

function validScreenName(name) {
  if (typeof name !== 'string') return false;
  const norm = normalizeScreenName(name);
  return SCREEN_NAME_RE.test(name) && name.length <= 20 && norm.length >= 3 && norm.length <= 16;
}

function requireAuthKey(k) {
  if (typeof k !== 'string' || !AUTH_KEY_RE.test(k)) throw new HttpError(400, 'Malformed credentials.');
  return k;
}

function parsePublicKey(k) {
  try {
    const j = JSON.parse(k);
    if (j.kty !== 'EC' || j.crv !== 'P-256' || !B64URL_RE.test(j.x) || !B64URL_RE.test(j.y)
        || j.x.length !== 43 || j.y.length !== 43) throw new Error();
    return JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y });
  } catch {
    throw new HttpError(400, 'Malformed public key.');
  }
}

function parseWrappedKey(k) {
  try {
    if (typeof k !== 'string' || k.length > 1024) throw new Error();
    const j = JSON.parse(k);
    if (j.v !== 1 || !B64_RE.test(j.iv) || j.iv.length !== 16 || !B64_RE.test(j.ct) || j.ct.length > 600) throw new Error();
    return JSON.stringify({ v: 1, iv: j.iv, ct: j.ct });
  } catch {
    throw new HttpError(400, 'Malformed key backup.');
  }
}

function parseGroup(g) {
  const group = typeof g === 'string' ? g.trim() : '';
  if (!GROUP_RE.test(group)) throw new HttpError(400, 'Group names are 1-24 letters, numbers or spaces.');
  return group;
}

// ---------------------------------------------------------------------------
// Rate limiting (in memory; nothing about clients is persisted)

class RateLimiter {
  constructor() {
    this.buckets = new Map();
  }

  hit(key, limit, windowMs) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.reset <= now) {
      b = { count: 0, reset: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > limit) {
      throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil((b.reset - now) / 60000)} minute(s).`);
    }
  }

  sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (b.reset <= now) this.buckets.delete(k);
  }
}

// ---------------------------------------------------------------------------

export function createApp({ config, db }) {
  const store = createStore(db);
  const limiter = new RateLimiter();
  const hub = new Hub({ store, config });
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  function securityHeaders(res) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    if (config.allowedOrigins.length) return config.allowedOrigins.includes(origin);
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  const cookieName = config.cookieSecure ? '__Host-sid' : 'sid';

  function sessionFromReq(req) {
    const token = parseCookies(req)[cookieName];
    if (!token || token.length > 100) return null;
    const row = store.sessionUser(token);
    return row ? { user: row, tokenHash: row.token_hash } : null;
  }

  function setSessionCookie(res, token, maxAgeMs) {
    const parts = [`${cookieName}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (config.cookieSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  async function readJson(req) {
    const type = req.headers['content-type'] || '';
    if (!type.startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Request too large.');
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      return body;
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
  }

  function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(data),
    });
    res.end(data);
  }

  function buddyView(meId, row) {
    return {
      screenName: row.display,
      group: row.group_name,
      publicKey: row.public_key,
      ...hub.presenceOf(row.id),
    };
  }

  function buddyListFor(meId) {
    return {
      buddies: store.buddies(meId).map((r) => buddyView(meId, r)),
      incoming: store.incoming(meId),
      outgoing: store.outgoing(meId),
      blocked: store.blocked(meId),
    };
  }

  function otherUser(name, meId) {
    const other = typeof name === 'string' ? store.userByName(name) : null;
    if (!other) throw new HttpError(404, 'No user by that screen name.');
    if (other.id === meId) throw new HttpError(400, "That's you!");
    return other;
  }

  // Dummy hash used to keep response time the same for unknown screen names.
  const dummy = hashAuthKey('A'.repeat(43) + '=');

  // -------------------------------------------------------------------------
  // Routes

  const routes = {
    'POST /api/register': async (req, res, body) => {
      const ip = clientIp(req);
      limiter.hit(`register:${ip}`, config.registrationsPerHourPerIp, 3600_000);
      const { screenName, inviteCode } = body;
      if (!validScreenName(screenName)) {
        throw new HttpError(400, 'Screen names are 3-16 letters or numbers, starting with a letter. Single spaces are OK.');
      }
      const authKey = requireAuthKey(body.authKey);
      const publicKey = parsePublicKey(body.publicKey);
      const wrappedKey = parseWrappedKey(body.wrappedKey);
      if (typeof inviteCode !== 'string' || !inviteCode.trim() || inviteCode.length > 40) {
        throw new HttpError(403, 'An invite code is required.');
      }
      const { salt, hash } = await hashAuthKey(authKey);
      const result = store.createUser({
        inviteHash: sha256(normalizeInvite(inviteCode)),
        display: screenName,
        salt, hash, publicKey, wrappedKey,
      });
      if (result.error === 'invite') throw new HttpError(403, 'That invite code is invalid, expired or already used.');
      if (result.error === 'taken') throw new HttpError(409, 'That screen name is taken.');
      const token = store.createSession(result.id, config.sessionTtlMs);
      setSessionCookie(res, token, config.sessionTtlMs);
      sendJson(res, 201, { screenName });
    },

    'POST /api/login': async (req, res, body) => {
      const ip = clientIp(req);
      const name = typeof body.screenName === 'string' ? normalizeScreenName(body.screenName).slice(0, 32) : '';
      limiter.hit(`login-ip:${ip}`, 20, 15 * 60_000);
      limiter.hit(`login-user:${name}`, 10, 15 * 60_000);
      const authKey = requireAuthKey(body.authKey);
      const user = name ? store.userByName(name) : null;
      let ok = false;
      if (user) ok = await verifyAuthKey(authKey, user.auth_salt, user.auth_hash);
      else await verifyAuthKey(authKey, (await dummy).salt, (await dummy).hash);
      if (!ok) throw new HttpError(401, 'Incorrect screen name or password.');
      // Replace any session this browser already had.
      const old = sessionFromReq(req);
      if (old) store.deleteSession(old.tokenHash);
      const token = store.createSession(user.id, config.sessionTtlMs);
      setSessionCookie(res, token, config.sessionTtlMs);
      sendJson(res, 200, { screenName: user.display, publicKey: user.public_key, wrappedKey: user.wrapped_key });
    },

    // Public so it's safe to call on page load; ends the session if there is one.
    'POST /api/logout': async (req, res) => {
      const session = sessionFromReq(req);
      if (session) {
        store.deleteSession(session.tokenHash);
        hub.disconnectSession(session.tokenHash);
      }
      setSessionCookie(res, '', 0);
      sendJson(res, 200, { ok: true });
    },

    'GET /api/me': async (req, res, body, session) => {
      sendJson(res, 200, {
        screenName: session.user.display,
        publicKey: session.user.public_key,
      });
    },

    'POST /api/password': async (req, res, body, session) => {
      limiter.hit(`password:${session.user.id}`, 5, 15 * 60_000);
      const oldKey = requireAuthKey(body.oldAuthKey);
      const newKey = requireAuthKey(body.newAuthKey);
      const wrappedKey = parseWrappedKey(body.wrappedKey);
      if (!(await verifyAuthKey(oldKey, session.user.auth_salt, session.user.auth_hash))) {
        throw new HttpError(401, 'Your current password is incorrect.');
      }
      const { salt, hash } = await hashAuthKey(newKey);
      store.updateAuth(session.user.id, salt, hash, wrappedKey);
      store.deleteOtherSessions(session.user.id, session.tokenHash);
      hub.disconnectUser(session.user.id, session.tokenHash);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/account/delete': async (req, res, body, session) => {
      limiter.hit(`delete:${session.user.id}`, 5, 15 * 60_000);
      const authKey = requireAuthKey(body.authKey);
      if (!(await verifyAuthKey(authKey, session.user.auth_salt, session.user.auth_hash))) {
        throw new HttpError(401, 'Incorrect password.');
      }
      const buddyIds = store.buddyIds(session.user.id);
      store.deleteUser(session.user.id);
      for (const id of buddyIds) hub.send(id, { t: 'buddyRemoved', screenName: session.user.display });
      hub.disconnectUser(session.user.id);
      setSessionCookie(res, '', 0);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/invites': async (req, res, body, session) => {
      if (store.countInvites(session.user.id) >= config.invitesPerUser) {
        throw new HttpError(429, `You already have ${config.invitesPerUser} unused invites. Wait for them to be used or expire.`);
      }
      sendJson(res, 201, store.createInvite(session.user.id, config.inviteTtlMs));
    },

    'GET /api/buddies': async (req, res, body, session) => {
      sendJson(res, 200, buddyListFor(session.user.id));
    },

    'POST /api/buddies/request': async (req, res, body, session) => {
      limiter.hit(`request:${session.user.id}`, 30, 3600_000);
      const me = session.user;
      const other = otherUser(body.screenName, me.id);
      if (store.areBuddies(me.id, other.id)) throw new HttpError(409, `${other.display} is already on your Buddy List.`);
      if (store.isBlocked(me.id, other.id)) throw new HttpError(409, `Unblock ${other.display} first.`);
      // If they've blocked us, pretend the request went through.
      if (store.isBlocked(other.id, me.id)) return sendJson(res, 200, { status: 'requested' });
      const status = store.requestBuddy(me.id, other.id);
      if (status === 'accepted') {
        hub.send(other.id, { t: 'buddyAdded', buddy: buddyView(other.id, { ...me, group_name: 'Buddies' }) });
        hub.send(me.id, { t: 'buddyAdded', buddy: buddyView(me.id, { ...other, group_name: 'Buddies' }) });
      } else {
        hub.send(other.id, { t: 'buddyRequest', screenName: me.display });
      }
      sendJson(res, 200, { status, screenName: other.display });
    },

    'POST /api/buddies/respond': async (req, res, body, session) => {
      const me = session.user;
      const other = otherUser(body.screenName, me.id);
      const accept = body.accept === true;
      if (!store.respondBuddy(me.id, other.id, accept)) throw new HttpError(404, 'No pending request from that user.');
      if (accept) {
        hub.send(other.id, { t: 'buddyAdded', buddy: buddyView(other.id, { ...me, group_name: 'Buddies' }) });
        hub.send(me.id, { t: 'buddyAdded', buddy: buddyView(me.id, { ...other, group_name: 'Buddies' }) });
      }
      sendJson(res, 200, { ok: true });
    },

    'POST /api/buddies/remove': async (req, res, body, session) => {
      const me = session.user;
      const other = otherUser(body.screenName, me.id);
      store.removeBuddy(me.id, other.id);
      hub.send(other.id, { t: 'buddyRemoved', screenName: me.display });
      hub.send(me.id, { t: 'buddyRemoved', screenName: other.display });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/buddies/group': async (req, res, body, session) => {
      const other = otherUser(body.screenName, session.user.id);
      if (!store.setGroup(session.user.id, other.id, parseGroup(body.group))) throw new HttpError(404, 'Not on your Buddy List.');
      sendJson(res, 200, { ok: true });
    },

    'POST /api/block': async (req, res, body, session) => {
      const me = session.user;
      const other = otherUser(body.screenName, me.id);
      const wasBuddy = store.areBuddies(me.id, other.id);
      store.block(me.id, other.id);
      if (wasBuddy) hub.send(other.id, { t: 'buddyRemoved', screenName: me.display });
      hub.send(me.id, { t: 'buddyRemoved', screenName: other.display });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/unblock': async (req, res, body, session) => {
      const other = otherUser(body.screenName, session.user.id);
      store.unblock(session.user.id, other.id);
      sendJson(res, 200, { ok: true });
    },
  };
  const PUBLIC_ROUTES = new Set(['POST /api/register', 'POST /api/login', 'POST /api/logout']);

  // -------------------------------------------------------------------------

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Bad path.');
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.resolve(config.publicDir, '.' + rel);
    if (!file.startsWith(config.publicDir + path.sep)) throw new HttpError(404, 'Not found.');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new HttpError(404, 'Not found.');
    }
    if (!stat.isFile()) throw new HttpError(404, 'Not found.');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    securityHeaders(res);
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return res.end('ok');
    }
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    const key = `${req.method} ${pathname}`;
    const route = routes[key];
    if (!route) throw new HttpError(404, 'Not found.');
    // CSRF defence in depth (cookies are also SameSite=Strict).
    if (req.method !== 'GET' && !originAllowed(req)) throw new HttpError(403, 'Cross-origin request refused.');

    let session = null;
    if (!PUBLIC_ROUTES.has(key)) {
      session = sessionFromReq(req);
      if (!session) throw new HttpError(401, 'Please sign on again.');
      limiter.hit(`api:${session.user.id}`, 300, 60_000);
    }
    const body = req.method === 'GET' ? {} : await readJson(req);
    await route(req, res, body, session);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.destroy();
      sendJson(res, status, { error: status === 500 ? 'Something went wrong.' : err.message });
    });
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;

  hub.attach(server, { sessionFromReq, originAllowed });

  const timer = setInterval(() => {
    store.purgeExpired();
    limiter.sweep();
  }, 10 * 60_000);
  timer.unref();

  return {
    server,
    store,
    hub,
    close() {
      clearInterval(timer);
      hub.close();
      server.close();
    },
  };
}
