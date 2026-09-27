import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function normalizeScreenName(name) {
  return String(name).replace(/\s+/g, '').toLowerCase();
}

export function normalizeInvite(code) {
  return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function newInviteCode() {
  const bytes = crypto.randomBytes(16);
  let code = '';
  for (let i = 0; i < 16; i++) code += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  return code.match(/.{4}/g).join('-');
}

// The client already sends a high-entropy key derived with PBKDF2; the server
// hashes it again so a database leak cannot be replayed as a login credential.
export async function hashAuthKey(authKey, salt = crypto.randomBytes(16).toString('base64')) {
  const hash = (await scrypt(authKey, salt, 32, SCRYPT_OPTS)).toString('base64');
  return { salt, hash };
}

export async function verifyAuthKey(authKey, salt, hash) {
  const actual = await scrypt(authKey, salt, 32, SCRYPT_OPTS);
  const expected = Buffer.from(hash, 'base64');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

export function createStore(db) {
  const q = (sql) => db.prepare(sql);
  const s = {
    userByNorm: q('SELECT * FROM users WHERE norm = ?'),
    userById: q('SELECT * FROM users WHERE id = ?'),
    userCount: q('SELECT COUNT(*) AS n FROM users'),
    insertUser: q('INSERT INTO users (norm, display, auth_salt, auth_hash, public_key, wrapped_key) VALUES (?, ?, ?, ?, ?, ?)'),
    updateAuth: q('UPDATE users SET auth_salt = ?, auth_hash = ?, wrapped_key = ? WHERE id = ?'),
    deleteUser: q('DELETE FROM users WHERE id = ?'),
    listUsers: q('SELECT id, display FROM users ORDER BY norm'),

    insertSession: q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    session: q('SELECT s.token_hash, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'),
    deleteSession: q('DELETE FROM sessions WHERE token_hash = ?'),
    deleteOtherSessions: q('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),

    insertInvite: q('INSERT INTO invites (code_hash, created_by, expires_at) VALUES (?, ?, ?)'),
    invite: q('SELECT * FROM invites WHERE code_hash = ? AND expires_at > ?'),
    deleteInvite: q('DELETE FROM invites WHERE code_hash = ?'),
    countInvites: q('SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND expires_at > ?'),

    buddies: q(`SELECT u.id, u.display, u.norm, u.public_key, b.group_name FROM buddies b
                JOIN users u ON u.id = b.buddy_id WHERE b.owner_id = ? ORDER BY u.norm`),
    buddyIds: q('SELECT buddy_id FROM buddies WHERE owner_id = ?'),
    isBuddy: q('SELECT 1 FROM buddies WHERE owner_id = ? AND buddy_id = ?'),
    addBuddy: q('INSERT OR IGNORE INTO buddies (owner_id, buddy_id, group_name) VALUES (?, ?, ?)'),
    removeBuddy: q('DELETE FROM buddies WHERE (owner_id = ? AND buddy_id = ?) OR (owner_id = ? AND buddy_id = ?)'),
    setGroup: q('UPDATE buddies SET group_name = ? WHERE owner_id = ? AND buddy_id = ?'),

    incoming: q('SELECT u.display FROM buddy_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ? ORDER BY u.norm'),
    outgoing: q('SELECT u.display FROM buddy_requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = ? ORDER BY u.norm'),
    hasRequest: q('SELECT 1 FROM buddy_requests WHERE from_id = ? AND to_id = ?'),
    addRequest: q('INSERT OR IGNORE INTO buddy_requests (from_id, to_id) VALUES (?, ?)'),
    deleteRequests: q('DELETE FROM buddy_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)'),

    isBlocked: q('SELECT 1 FROM blocks WHERE owner_id = ? AND blocked_id = ?'),
    block: q('INSERT OR IGNORE INTO blocks (owner_id, blocked_id) VALUES (?, ?)'),
    unblock: q('DELETE FROM blocks WHERE owner_id = ? AND blocked_id = ?'),
    blocked: q('SELECT u.display FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.owner_id = ? ORDER BY u.norm'),

    insertOffline: q('INSERT INTO offline_messages (to_id, from_id, msg_id, envelope, expires_at) VALUES (?, ?, ?, ?, ?)'),
    countOffline: q('SELECT COUNT(*) AS n FROM offline_messages WHERE to_id = ?'),
    offlineFor: q(`SELECT m.id, m.msg_id, m.envelope, u.display AS from_display FROM offline_messages m
                   JOIN users u ON u.id = m.from_id WHERE m.to_id = ? AND m.expires_at > ? ORDER BY m.id`),
    deleteOffline: q('DELETE FROM offline_messages WHERE id = ? AND to_id = ?'),

    purgeSessions: q('DELETE FROM sessions WHERE expires_at <= ?'),
    purgeInvites: q('DELETE FROM invites WHERE expires_at <= ?'),
    purgeOffline: q('DELETE FROM offline_messages WHERE expires_at <= ?'),
  };

  const tx = (fn) => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn(...args);
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  return {
    userByName: (name) => s.userByNorm.get(normalizeScreenName(name)),
    userById: (id) => s.userById.get(id),
    userCount: () => s.userCount.get().n,
    listUsers: () => s.listUsers.all(),

    createUser: tx(({ inviteHash, display, salt, hash, publicKey, wrappedKey }) => {
      if (!s.invite.get(inviteHash, Date.now())) return { error: 'invite' };
      const norm = normalizeScreenName(display);
      if (s.userByNorm.get(norm)) return { error: 'taken' };
      s.deleteInvite.run(inviteHash);
      const r = s.insertUser.run(norm, display, salt, hash, publicKey, wrappedKey);
      return { id: Number(r.lastInsertRowid) };
    }),
    updateAuth: (id, salt, hash, wrappedKey) => s.updateAuth.run(salt, hash, wrappedKey, id),
    deleteUser: (id) => s.deleteUser.run(id),

    createSession(userId, ttlMs) {
      const token = crypto.randomBytes(32).toString('base64url');
      s.insertSession.run(sha256(token), userId, Date.now() + ttlMs);
      return token;
    },
    sessionUser: (token) => s.session.get(sha256(token), Date.now()),
    deleteSession: (tokenHash) => s.deleteSession.run(tokenHash),
    deleteOtherSessions: (userId, keepHash) => s.deleteOtherSessions.run(userId, keepHash),

    createInvite(createdBy, ttlMs) {
      const code = newInviteCode();
      s.insertInvite.run(sha256(normalizeInvite(code)), createdBy, Date.now() + ttlMs);
      return { code, expiresAt: Date.now() + ttlMs };
    },
    countInvites: (userId) => s.countInvites.get(userId, Date.now()).n,
    countAllInvites: () => db.prepare('SELECT COUNT(*) AS n FROM invites WHERE expires_at > ?').get(Date.now()).n,

    buddies: (userId) => s.buddies.all(userId),
    buddyIds: (userId) => s.buddyIds.all(userId).map((r) => r.buddy_id),
    areBuddies: (a, b) => !!s.isBuddy.get(a, b) && !!s.isBuddy.get(b, a),
    incoming: (userId) => s.incoming.all(userId).map((r) => r.display),
    outgoing: (userId) => s.outgoing.all(userId).map((r) => r.display),
    blocked: (userId) => s.blocked.all(userId).map((r) => r.display),
    isBlocked: (owner, other) => !!s.isBlocked.get(owner, other),

    // Returns 'requested' or 'accepted' (when the other side had already asked).
    requestBuddy: tx((fromId, toId) => {
      if (s.hasRequest.get(toId, fromId)) {
        s.deleteRequests.run(fromId, toId, toId, fromId);
        s.addBuddy.run(fromId, toId, 'Buddies');
        s.addBuddy.run(toId, fromId, 'Buddies');
        return 'accepted';
      }
      s.addRequest.run(fromId, toId);
      return 'requested';
    }),
    respondBuddy: tx((meId, fromId, accept) => {
      if (!s.hasRequest.get(fromId, meId)) return false;
      s.deleteRequests.run(fromId, meId, meId, fromId);
      if (accept) {
        s.addBuddy.run(meId, fromId, 'Buddies');
        s.addBuddy.run(fromId, meId, 'Buddies');
      }
      return true;
    }),
    removeBuddy: tx((a, b) => {
      s.removeBuddy.run(a, b, b, a);
      s.deleteRequests.run(a, b, b, a);
    }),
    setGroup: (owner, buddy, group) => s.setGroup.run(group, owner, buddy).changes > 0,
    block: tx((owner, other) => {
      s.removeBuddy.run(owner, other, other, owner);
      s.deleteRequests.run(owner, other, other, owner);
      s.block.run(owner, other);
    }),
    unblock: (owner, other) => s.unblock.run(owner, other),

    queueOffline(toId, fromId, msgId, envelope, ttlMs, max) {
      if (s.countOffline.get(toId).n >= max) return false;
      s.insertOffline.run(toId, fromId, msgId, envelope, Date.now() + ttlMs);
      return true;
    },
    offlineFor: (userId) => s.offlineFor.all(userId, Date.now()),
    deleteOffline: (id, toId) => s.deleteOffline.run(id, toId),

    purgeExpired() {
      const now = Date.now();
      s.purgeSessions.run(now);
      s.purgeInvites.run(now);
      s.purgeOffline.run(now);
    },
  };
}
