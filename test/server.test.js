import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import * as C from '../public/js/crypto.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db.js';

const ITER = 1000;
let app;
let base;
let origin;

before(async () => {
  const config = { ...loadConfig({ NODE_ENV: 'development', REGISTRATIONS_PER_HOUR: '1000' }), dbFile: ':memory:' };
  app = createApp({ config, db: openDb(':memory:') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${app.server.address().port}`;
  base = origin;
});

after(() => app.close());

async function req(method, path, body, cookie, extraHeaders = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Origin: origin,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}

async function register(name, password = 'long password 1') {
  const { code } = app.store.createInvite(null, 60_000);
  const keys = await C.deriveAccountKeys(name, password, ITER);
  const id = await C.generateIdentity(keys.wrapKey, keys.norm);
  const r = await req('POST', '/api/register', {
    screenName: name, inviteCode: code, authKey: keys.authKey, publicKey: id.publicKey, wrappedKey: id.wrappedKey,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { name, norm: keys.norm, cookie: r.cookie, ...keys, ...id, password };
}

function connect(user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Cookie: user.cookie, Origin: origin } });
    const queue = [];
    const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else queue.push(m);
    });
    ws.next = (pred = () => true) => {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        waiters.push({ pred, resolve: res });
        setTimeout(() => rej(new Error('timeout waiting for ws message')), 3000);
      });
    };
    ws.sendJson = (m) => ws.send(JSON.stringify(m));
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (_, res) => reject(new Error(`ws ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

async function befriend(a, b) {
  assert.equal((await req('POST', '/api/buddies/request', { screenName: b.name }, a.cookie)).status, 200);
  assert.equal((await req('POST', '/api/buddies/respond', { screenName: a.name, accept: true }, b.cookie)).status, 200);
}

test('security headers are set', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('static serving refuses path traversal', async () => {
  const r = await fetch(base + '/%2e%2e/package.json');
  assert.equal(r.status, 404);
});

test('registration requires a valid, single-use invite', async () => {
  const keys = await C.deriveAccountKeys('NoInvite', 'long password 1', ITER);
  const id = await C.generateIdentity(keys.wrapKey, keys.norm);
  const body = { screenName: 'NoInvite', authKey: keys.authKey, publicKey: id.publicKey, wrappedKey: id.wrappedKey };
  assert.equal((await req('POST', '/api/register', { ...body, inviteCode: 'NOPE-NOPE-NOPE-NOPE' })).status, 403);
  const { code } = app.store.createInvite(null, 60_000);
  assert.equal((await req('POST', '/api/register', { ...body, inviteCode: code.toLowerCase() })).status, 201);
  const again = await req('POST', '/api/register', { ...body, screenName: 'Another One', inviteCode: code });
  assert.equal(again.status, 403);
});

test('screen names are unique ignoring case and spaces', async () => {
  await register('Cool Dude');
  const { code } = app.store.createInvite(null, 60_000);
  const keys = await C.deriveAccountKeys('cooldude', 'long password 1', ITER);
  const id = await C.generateIdentity(keys.wrapKey, keys.norm);
  const r = await req('POST', '/api/register', { screenName: 'cooldude', inviteCode: code, authKey: keys.authKey, publicKey: id.publicKey, wrappedKey: id.wrappedKey });
  assert.equal(r.status, 409);
});

test('login returns the wrapped key; wrong password is refused', async () => {
  const u = await register('Login Test');
  const good = await req('POST', '/api/login', { screenName: 'logintest', authKey: u.authKey });
  assert.equal(good.status, 200);
  assert.equal(good.body.screenName, 'Login Test');
  await C.unwrapIdentity(good.body.wrappedKey, u.wrapKey, u.norm);
  const bad = await C.deriveAccountKeys('Login Test', 'not the password', ITER);
  assert.equal((await req('POST', '/api/login', { screenName: 'Login Test', authKey: bad.authKey })).status, 401);
  assert.equal((await req('POST', '/api/login', { screenName: 'nobody here', authKey: bad.authKey })).status, 401);
});

test('state-changing requests from another origin are refused', async () => {
  const u = await register('Csrf Target');
  const r = await req('POST', '/api/invites', {}, u.cookie, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('websocket refuses cross-origin and unauthenticated connections', async () => {
  const u = await register('Ws Target');
  const attempt = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers });
    ws.on('unexpected-response', (_, res) => resolve(res.statusCode));
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('error', () => resolve('error'));
  });
  assert.equal(await attempt({ Cookie: u.cookie, Origin: 'https://evil.example' }), 403);
  assert.equal(await attempt({ Origin: origin }), 401);
});

test('buddies exchange end-to-end encrypted IMs; server sees only ciphertext', async () => {
  const alice = await register('Alice');
  const bob = await register('Bob');
  const wa = await connect(alice);
  const wb = await connect(bob);

  await req('POST', '/api/buddies/request', { screenName: 'bob' }, alice.cookie);
  assert.equal((await wb.next((m) => m.t === 'buddyRequest')).screenName, 'Alice');
  await req('POST', '/api/buddies/respond', { screenName: 'Alice', accept: true }, bob.cookie);
  const added = await wa.next((m) => m.t === 'buddyAdded');
  assert.equal(added.buddy.screenName, 'Bob');
  assert.equal(added.buddy.online, true);
  assert.equal(added.buddy.publicKey, bob.publicKey);

  const key = await C.deriveConversationKey(alice.privateKey, added.buddy.publicKey);
  const id = C.randomId();
  const env = await C.encryptMessage(key, { from: 'alice', to: 'bob', id }, { text: 'secret hello', ts: Date.now() });
  wa.sendJson({ t: 'im', to: 'Bob', id, env });
  assert.deepEqual(await wa.next((m) => m.t === 'sent'), { t: 'sent', id });
  const got = await wb.next((m) => m.t === 'im');
  assert.equal(got.from, 'Alice');
  assert.ok(!JSON.stringify(got).includes('secret hello'));
  const bkey = await C.deriveConversationKey(bob.privateKey, alice.publicKey);
  const payload = await C.decryptMessage(bkey, { from: got.from, to: 'bob', id: got.id }, got.env);
  assert.equal(payload.text, 'secret hello');

  // Typing and away status reach the buddy.
  wa.sendJson({ t: 'typing', to: 'Bob', on: true });
  assert.equal((await wb.next((m) => m.t === 'typing')).on, true);
  wa.sendJson({ t: 'status', away: true, awayMessage: 'brb' });
  const p = await wb.next((m) => m.t === 'presence' && m.away);
  assert.equal(p.awayMessage, 'brb');

  // Sign-off presence.
  wa.close();
  const off = await wb.next((m) => m.t === 'presence' && !m.online);
  assert.equal(off.screenName, 'Alice');
  wb.close();
});

test('non-buddies cannot message each other', async () => {
  const x = await register('Stranger X');
  const y = await register('Stranger Y');
  const wx = await connect(x);
  const env = { v: 1, salt: 'A'.repeat(22) + '==', iv: 'A'.repeat(16), ct: 'AAAA' };
  wx.sendJson({ t: 'im', to: 'Stranger Y', id: 'abcdefgh1234', env });
  const err = await wx.next((m) => m.t === 'error');
  assert.match(err.error, /Buddy List/);
  wx.close();
  assert.ok(y);
});

test('messages to offline buddies are queued encrypted and deleted after delivery', async () => {
  const a = await register('Sender Sam');
  const b = await register('Offline Olly');
  await befriend(a, b);
  const wa = await connect(a);
  const env = { v: 1, salt: 'A'.repeat(22) + '==', iv: 'A'.repeat(16), ct: 'Q2lwaGVydGV4dA==' };
  wa.sendJson({ t: 'im', to: 'Offline Olly', id: 'queued-msg-1', env });
  assert.equal((await wa.next((m) => m.t === 'sent')).queued, true);

  const wb = await connect(b);
  const got = await wb.next((m) => m.t === 'im');
  assert.equal(got.offline, true);
  assert.equal(got.id, 'queued-msg-1');
  assert.deepEqual(got.env, env);
  wb.sendJson({ t: 'delivered', oids: [got.oid] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.store.offlineFor(app.store.userByName('Offline Olly').id).length, 0);
  wa.close();
  wb.close();
});

test('blocking removes the buddy and silently drops new requests', async () => {
  const a = await register('Blocker');
  const b = await register('Blockee');
  await befriend(a, b);
  assert.equal((await req('POST', '/api/block', { screenName: 'Blockee' }, a.cookie)).status, 200);
  assert.equal(app.store.areBuddies(app.store.userByName('Blocker').id, app.store.userByName('Blockee').id), false);
  const r = await req('POST', '/api/buddies/request', { screenName: 'Blocker' }, b.cookie);
  assert.equal(r.body.status, 'requested');
  assert.deepEqual((await req('GET', '/api/buddies', null, a.cookie)).body.incoming, []);
});

test('password change re-wraps keys and revokes other sessions', async () => {
  const u = await register('Pw Changer');
  const second = await req('POST', '/api/login', { screenName: u.name, authKey: u.authKey });
  const next = await C.deriveAccountKeys(u.name, 'brand new password', ITER);
  const wrappedKey = await C.rewrapIdentity(u.wrappedKey, u.wrapKey, next.wrapKey, u.norm);
  const r = await req('POST', '/api/password', { oldAuthKey: u.authKey, newAuthKey: next.authKey, wrappedKey }, u.cookie);
  assert.equal(r.status, 200);
  assert.equal((await req('GET', '/api/me', null, second.cookie)).status, 401);
  assert.equal((await req('GET', '/api/me', null, u.cookie)).status, 200);
  const login = await req('POST', '/api/login', { screenName: u.name, authKey: next.authKey });
  assert.equal(login.status, 200);
  await C.unwrapIdentity(login.body.wrappedKey, next.wrapKey, u.norm);
});

test('account deletion removes the user', async () => {
  const u = await register('Deleter');
  assert.equal((await req('POST', '/api/account/delete', { authKey: u.authKey }, u.cookie)).status, 200);
  assert.equal(app.store.userByName('Deleter'), undefined);
  assert.equal((await req('GET', '/api/me', null, u.cookie)).status, 401);
});

test('login is rate limited per screen name', async () => {
  await register('Rate Limited');
  const bad = await C.deriveAccountKeys('Rate Limited', 'nope nope nope', ITER);
  let last;
  for (let i = 0; i < 11; i++) last = await req('POST', '/api/login', { screenName: 'Rate Limited', authKey: bad.authKey });
  assert.equal(last.status, 429);
});
