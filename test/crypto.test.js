import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as C from '../public/js/crypto.js';

const ITER = 1000; // fast for tests; the app uses C.PBKDF2_ITERATIONS

async function account(name, password) {
  const keys = await C.deriveAccountKeys(name, password, ITER);
  const id = await C.generateIdentity(keys.wrapKey, keys.norm);
  return { name, ...keys, ...id };
}

test('key derivation is deterministic and password-dependent', async () => {
  const a = await C.deriveAccountKeys('Some One', 'correct horse', ITER);
  const b = await C.deriveAccountKeys('someone', 'correct horse', ITER);
  const c = await C.deriveAccountKeys('someone', 'wrong horse!', ITER);
  assert.equal(a.authKey, b.authKey);
  assert.notEqual(a.authKey, c.authKey);
  assert.match(a.authKey, /^[A-Za-z0-9+/]{43}=$/);
});

test('identity key unwraps only with the right password', async () => {
  const alice = await account('alice', 'password one');
  const again = await C.deriveAccountKeys('alice', 'password one', ITER);
  await C.unwrapIdentity(alice.wrappedKey, again.wrapKey, 'alice');
  const wrong = await C.deriveAccountKeys('alice', 'password two', ITER);
  await assert.rejects(C.unwrapIdentity(alice.wrappedKey, wrong.wrapKey, 'alice'));
  // Bound to the screen name, too.
  await assert.rejects(C.unwrapIdentity(alice.wrappedKey, again.wrapKey, 'mallory'));
});

test('rewrap after password change', async () => {
  const alice = await account('alice', 'password one');
  const next = await C.deriveAccountKeys('alice', 'password two', ITER);
  const rewrapped = await C.rewrapIdentity(alice.wrappedKey, alice.wrapKey, next.wrapKey, 'alice');
  await C.unwrapIdentity(rewrapped, next.wrapKey, 'alice');
  await assert.rejects(C.unwrapIdentity(rewrapped, alice.wrapKey, 'alice'));
});

test('messages round-trip and are bound to sender, recipient and id', async () => {
  const alice = await account('alice', 'pw alice 123');
  const bob = await account('bob', 'pw bob 12345');
  const eve = await account('eve', 'pw eve 12345');
  const ab = await C.deriveConversationKey(alice.privateKey, bob.publicKey);
  const ba = await C.deriveConversationKey(bob.privateKey, alice.publicKey);
  const meta = { from: 'alice', to: 'bob', id: 'abcdefgh1234' };
  const env = await C.encryptMessage(ab, meta, { text: 'hi bob', ts: 1 });
  assert.deepEqual(await C.decryptMessage(ba, meta, env), { text: 'hi bob', ts: 1 });

  await assert.rejects(C.decryptMessage(ba, { ...meta, id: 'other-id-123' }, env));
  await assert.rejects(C.decryptMessage(ba, { ...meta, from: 'eve' }, env));
  const eb = await C.deriveConversationKey(eve.privateKey, bob.publicKey);
  await assert.rejects(C.decryptMessage(eb, meta, env));
  const tampered = { ...env, ct: env.ct.slice(0, -4) + (env.ct.endsWith('AAA=') ? 'BBB=' : 'AAA=') };
  await assert.rejects(C.decryptMessage(ba, meta, tampered));
});

test('safety numbers match on both sides and differ per pair', async () => {
  const alice = await account('alice', 'pw alice 123');
  const bob = await account('bob', 'pw bob 12345');
  const eve = await account('eve', 'pw eve 12345');
  const s1 = await C.safetyNumber('alice', alice.publicKey, 'bob', bob.publicKey);
  const s2 = await C.safetyNumber('bob', bob.publicKey, 'alice', alice.publicKey);
  assert.deepEqual(s1, s2);
  assert.equal(s1.length, 12);
  assert.ok(s1.every((g) => /^\d{5}$/.test(g)));
  const s3 = await C.safetyNumber('alice', alice.publicKey, 'bob', eve.publicKey);
  assert.notDeepEqual(s1, s3);
});

test('room keys wrap per member and room messages are bound to room, epoch and sender', async () => {
  const alice = await account('alice', 'pw alice 123');
  const bob = await account('bob', 'pw bob 12345');
  const raw = C.newRoomKey();
  const toBob = await C.deriveConversationKey(alice.privateKey, bob.publicKey);
  const wrapped = await C.wrapRoomKey(toBob, { roomId: 7, epoch: 2, from: 'alice', to: 'bob' }, raw);
  const fromAlice = await C.deriveConversationKey(bob.privateKey, alice.publicKey);
  const got = await C.unwrapRoomKey(fromAlice, { roomId: 7, epoch: 2, from: 'alice', to: 'bob' }, wrapped);
  assert.deepEqual(got, raw);
  await assert.rejects(C.unwrapRoomKey(fromAlice, { roomId: 8, epoch: 2, from: 'alice', to: 'bob' }, wrapped));

  const k = await C.importRoomKey(raw);
  const meta = { roomId: 7, epoch: 2, from: 'alice', id: 'room-msg-123' };
  const env = await C.encryptRoomMessage(k, meta, { text: 'hi room', ts: 1 });
  assert.deepEqual(await C.decryptRoomMessage(k, meta, env), { text: 'hi room', ts: 1 });
  await assert.rejects(C.decryptRoomMessage(k, { ...meta, from: 'bob' }, env));
  await assert.rejects(C.decryptRoomMessage(k, { ...meta, epoch: 3 }, env));
  await assert.rejects(C.decryptRoomMessage(await C.importRoomKey(C.newRoomKey()), meta, env));
});
