// End-to-end encryption primitives.
//
// This module runs unchanged in the browser and in Node (for tests); it only
// relies on the standard WebCrypto API (globalThis.crypto.subtle).
//
// Scheme overview
// ---------------
// * The password never leaves the device. PBKDF2 turns it into a master key,
//   which HKDF splits into:
//     - authKey: sent to the server as the login credential (server re-hashes it)
//     - wrapKey: an AES-GCM key that encrypts the user's private identity key
// * Each account has a long-term ECDH P-256 identity key pair. The server stores
//   the public key and the *encrypted* private key only.
// * Two buddies derive a shared secret with ECDH. Every message gets a fresh
//   AES-256-GCM key via HKDF with a random salt. The sender, recipient and
//   message id are bound in as associated data, so the server cannot re-route
//   or re-label ciphertext without detection.
// * Safety numbers let two people confirm, out of band, that the server handed
//   them each other's real public keys.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERATIONS = 600_000;
const PREFIX = 'buddy-messenger/v1';
const CURVE = { name: 'ECDH', namedCurve: 'P-256' };

export function normalizeScreenName(name) {
  return String(name).replace(/\s+/g, '').toLowerCase();
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function b64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomId() {
  return b64(randomBytes(12)).replace(/\+/g, '-').replace(/\//g, '_');
}

// Canonical JSON form of a public key so that both sides (and the server)
// agree byte-for-byte on what is being fingerprinted.
export function canonicalPublicKey(jwk) {
  const k = typeof jwk === 'string' ? JSON.parse(jwk) : jwk;
  return JSON.stringify({ crv: k.crv, kty: k.kty, x: k.x, y: k.y });
}

export async function deriveAccountKeys(screenName, password, iterations = PBKDF2_ITERATIONS) {
  const norm = normalizeScreenName(screenName);
  const salt = await subtle.digest('SHA-256', enc.encode(`${PREFIX}/salt/${norm}`));
  const pwKey = await subtle.importKey('raw', enc.encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const master = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, pwKey, 256);
  const hkdf = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const noSalt = new Uint8Array(0);
  const authBits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: noSalt, info: enc.encode(`${PREFIX}/auth`) }, hkdf, 256);
  const wrapKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: noSalt, info: enc.encode(`${PREFIX}/wrap`) },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { norm, authKey: b64(authBits), wrapKey };
}

async function wrapPkcs8(pkcs8, wrapKey, norm) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(`${PREFIX}/identity/${norm}`) }, wrapKey, pkcs8);
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}

async function unwrapPkcs8(wrappedKey, wrapKey, norm) {
  const w = JSON.parse(wrappedKey);
  return subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(w.iv), additionalData: enc.encode(`${PREFIX}/identity/${norm}`) },
    wrapKey, unb64(w.ct));
}

function importPrivate(pkcs8) {
  // Non-extractable: page scripts can use the key but never read it out.
  return subtle.importKey('pkcs8', pkcs8, CURVE, false, ['deriveBits']);
}

export async function generateIdentity(wrapKey, norm) {
  const pair = await subtle.generateKey(CURVE, true, ['deriveBits']);
  const publicKey = canonicalPublicKey(await subtle.exportKey('jwk', pair.publicKey));
  const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey);
  const wrappedKey = await wrapPkcs8(pkcs8, wrapKey, norm);
  return { publicKey, wrappedKey, privateKey: await importPrivate(pkcs8) };
}

export async function unwrapIdentity(wrappedKey, wrapKey, norm) {
  return importPrivate(await unwrapPkcs8(wrappedKey, wrapKey, norm));
}

export async function rewrapIdentity(wrappedKey, oldWrapKey, newWrapKey, norm) {
  return wrapPkcs8(await unwrapPkcs8(wrappedKey, oldWrapKey, norm), newWrapKey, norm);
}

// Shared secret between me and a buddy, as an HKDF base key.
export async function deriveConversationKey(myPrivateKey, theirPublicKey) {
  const pub = await subtle.importKey('jwk', JSON.parse(canonicalPublicKey(theirPublicKey)), CURVE, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: pub }, myPrivateKey, 256);
  return subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
}

function messageKey(convKey, salt, usage) {
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(`${PREFIX}/message`) },
    convKey, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

function messageAad({ from, to, id }) {
  return enc.encode(`${PREFIX}/message|${normalizeScreenName(from)}|${normalizeScreenName(to)}|${id}`);
}

export async function encryptMessage(convKey, meta, payload) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await messageKey(convKey, salt, 'encrypt');
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: messageAad(meta) }, key, enc.encode(JSON.stringify(payload)));
  return { v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

export async function decryptMessage(convKey, meta, envelope) {
  const key = await messageKey(convKey, unb64(envelope.salt), 'decrypt');
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: messageAad(meta) }, key, unb64(envelope.ct));
  return JSON.parse(dec.decode(pt));
}

// Short fingerprint of a single key, used to pin buddies' keys locally.
export async function keyFingerprint(publicKey) {
  const h = new Uint8Array(await subtle.digest('SHA-256', enc.encode(canonicalPublicKey(publicKey))));
  return Array.from(h.subarray(0, 16), (x) => x.toString(16).padStart(2, '0')).join('');
}

// 60-digit safety number shared by a pair of users (same on both sides).
export async function safetyNumber(nameA, keyA, nameB, keyB) {
  const parts = [
    [normalizeScreenName(nameA), canonicalPublicKey(keyA)],
    [normalizeScreenName(nameB), canonicalPublicKey(keyB)],
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const data = enc.encode(`${PREFIX}/safety|` + parts.map((p) => `${p[0]}:${p[1]}`).join('|'));
  const h = new Uint8Array(await subtle.digest('SHA-512', data));
  const groups = [];
  for (let i = 0; i < 12; i++) {
    let n = 0;
    for (let j = 0; j < 5; j++) n = n * 256 + h[i * 5 + j];
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups;
}
