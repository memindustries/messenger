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
    insertUser: q('INSERT INTO users (norm, display, auth_salt, auth_hash, public_key, wrapped_key, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    setAdmin: q('UPDATE users SET is_admin = ? WHERE id = ?'),
    updateAuth: q('UPDATE users SET auth_salt = ?, auth_hash = ?, wrapped_key = ? WHERE id = ?'),
    deleteUser: q('DELETE FROM users WHERE id = ?'),
    listUsers: q('SELECT id, display FROM users ORDER BY norm'),
    listAdmins: q('SELECT id, display, norm FROM users WHERE is_admin = 1 ORDER BY norm'),

    insertSession: q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    session: q('SELECT s.token_hash, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'),
    deleteSession: q('DELETE FROM sessions WHERE token_hash = ?'),
    deleteOtherSessions: q('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),

    insertInvite: q('INSERT INTO invites (code_hash, created_by, expires_at, max_uses, label) VALUES (?, ?, ?, ?, ?)'),
    invite: q('SELECT * FROM invites WHERE code_hash = ? AND expires_at > ? AND uses < max_uses'),
    useInvite: q('UPDATE invites SET uses = uses + 1 WHERE code_hash = ?'),
    deleteInvite: q('DELETE FROM invites WHERE code_hash = ?'),
    countInvites: q('SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND expires_at > ? AND uses < max_uses'),
    campaigns: q('SELECT label, uses, max_uses, expires_at FROM invites WHERE label IS NOT NULL ORDER BY expires_at DESC'),

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
    // Personal invites go as soon as they're used or expire; campaign codes stay
    // listed (with their sign-up counts) for 30 days after they expire.
    purgeInvites: q(`DELETE FROM invites WHERE (label IS NULL AND (expires_at <= ?1 OR uses >= max_uses))
                     OR (label IS NOT NULL AND expires_at <= ?1 - 2592000000)`),
    purgeOffline: q('DELETE FROM offline_messages WHERE expires_at <= ?'),
  };

  const r = {
    insert: q('INSERT INTO rooms (kind, name, norm, topic) VALUES (?, ?, ?, ?)'),
    get: q('SELECT * FROM rooms WHERE id = ?'),
    publicByNorm: q("SELECT id FROM rooms WHERE kind = 'public' AND norm = ?"),
    del: q('DELETE FROM rooms WHERE id = ?'),
    setTopic: q('UPDATE rooms SET topic = ? WHERE id = ?'),
    bumpEpoch: q('UPDATE rooms SET key_epoch = key_epoch + 1 WHERE id = ?'),
    publicList: q(`SELECT r.id, r.name, r.topic,
                     (SELECT COUNT(*) FROM room_members m WHERE m.room_id = r.id AND m.status = 'member') AS members
                   FROM rooms r WHERE r.kind = 'public' ORDER BY r.norm`),
    mine: q(`SELECT r.id, r.kind, r.name, r.topic, r.key_epoch, m.status, m.role FROM room_members m
             JOIN rooms r ON r.id = m.room_id WHERE m.user_id = ? ORDER BY r.norm`),
    membership: q('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?'),
    addMember: q('INSERT OR REPLACE INTO room_members (room_id, user_id, status, role) VALUES (?, ?, ?, ?)'),
    setStatus: q('UPDATE room_members SET status = ? WHERE room_id = ? AND user_id = ?'),
    setRole: q('UPDATE room_members SET role = ? WHERE room_id = ? AND user_id = ?'),
    removeMember: q('DELETE FROM room_members WHERE room_id = ? AND user_id = ?'),
    members: q(`SELECT u.id, u.display, u.norm, u.public_key, m.status, m.role FROM room_members m
                JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY m.rowid`),
    memberIds: q("SELECT user_id FROM room_members WHERE room_id = ? AND status = 'member'"),
    keyHolders: q('SELECT user_id FROM room_members WHERE room_id = ?'),
    nextOwner: q("SELECT user_id FROM room_members WHERE room_id = ? AND status = 'member' ORDER BY rowid LIMIT 1"),
    ownedPrivate: q(`SELECT COUNT(*) AS n FROM room_members m JOIN rooms r ON r.id = m.room_id
                     WHERE m.user_id = ? AND m.role = 'owner' AND r.kind = 'private'`),
    ban: q('INSERT OR IGNORE INTO room_bans (room_id, user_id) VALUES (?, ?)'),
    isBanned: q('SELECT 1 FROM room_bans WHERE room_id = ? AND user_id = ?'),
    insertKey: q('INSERT INTO room_keys (room_id, user_id, epoch, wrapped_by, envelope) VALUES (?, ?, ?, ?, ?)'),
    keyCount: q('SELECT COUNT(*) AS n FROM room_keys WHERE room_id = ? AND epoch = ?'),
    myKey: q(`SELECT k.envelope, u.display AS from_display, u.public_key AS from_public_key FROM room_keys k
              JOIN users u ON u.id = k.wrapped_by WHERE k.room_id = ? AND k.user_id = ? AND k.epoch = ?`),
    clearKeys: q('DELETE FROM room_keys WHERE room_id = ?'),
  };

  // Someone left a private room: hand over ownership if needed, delete the room
  // if it's empty, and retire the room key so a new one must be generated.
  function afterPrivateDeparture(roomId, wasOwner) {
    if (r.keyHolders.all(roomId).length === 0 || !r.nextOwner.get(roomId)) {
      r.del.run(roomId);
      return { deleted: true };
    }
    let newOwnerId = null;
    if (wasOwner) {
      newOwnerId = r.nextOwner.get(roomId).user_id;
      r.setRole.run('owner', roomId, newOwnerId);
    }
    r.bumpEpoch.run(roomId);
    r.clearKeys.run(roomId);
    return { deleted: false, newOwnerId, epoch: r.get.get(roomId).key_epoch };
  }

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

    // adminNames: normalized screen names that are always admins. They're reserved:
    // only an admin-issued single-use invite (CLI / first-run code) can claim them,
    // so nobody can grab one with a campaign code or a friend's invite.
    // inviteHash is null for open sign-up (no code given).
    createUser: tx(({ inviteHash, display, salt, hash, publicKey, wrappedKey, adminNames = [] }) => {
      const invite = inviteHash === null ? null : s.invite.get(inviteHash, Date.now());
      if (inviteHash !== null && !invite) return { error: 'invite' };
      const norm = normalizeScreenName(display);
      if (s.userByNorm.get(norm)) return { error: 'taken' };
      // An invite printed by the server (first-run code, `npm run invite`).
      const adminIssued = !!invite && invite.created_by === null && invite.max_uses === 1;
      const reserved = adminNames.includes(norm);
      if (reserved && !adminIssued) return { error: 'reserved' };
      if (invite) s.useInvite.run(inviteHash);
      // Configured admin names run the place. So does the very first account, but only
      // when created with the server's own code; with open sign-up a stranger could
      // otherwise be first.
      const isAdmin = reserved || (adminIssued && s.userCount.get().n === 0) ? 1 : 0;
      const r = s.insertUser.run(norm, display, salt, hash, publicKey, wrappedKey, isAdmin);
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
      s.insertInvite.run(sha256(normalizeInvite(code)), createdBy, Date.now() + ttlMs, 1, null);
      return { code, expiresAt: Date.now() + ttlMs };
    },
    // Reusable code with a use cap, e.g. posted in an Instagram story.
    createCampaign(code, maxUses, ttlMs) {
      const hash = sha256(normalizeInvite(code));
      s.deleteInvite.run(hash);
      s.insertInvite.run(hash, null, Date.now() + ttlMs, maxUses, code);
      return { code, maxUses, expiresAt: Date.now() + ttlMs };
    },
    campaigns: () => s.campaigns.all(),
    revokeInvite: (code) => s.deleteInvite.run(sha256(normalizeInvite(code))).changes > 0,
    inviteExists: (code) => !!db.prepare('SELECT 1 FROM invites WHERE code_hash = ?').get(sha256(normalizeInvite(code))),
    listAdmins: () => s.listAdmins.all(),
    setAdmin: (id, on) => s.setAdmin.run(on ? 1 : 0, id),
    // Make sure every configured admin name that exists is an admin.
    promoteAdmins(adminNames) {
      for (const norm of adminNames) {
        const u = s.userByNorm.get(norm);
        if (u && !u.is_admin) s.setAdmin.run(1, u.id);
      }
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

    // ---- Rooms ----------------------------------------------------------------
    room: (id) => r.get.get(id),
    publicRooms: () => r.publicList.all(),
    userRooms: (userId) => r.mine.all(userId),
    membership: (roomId, userId) => r.membership.get(roomId, userId),
    roomMembers: (roomId) => r.members.all(roomId),
    roomMemberIds: (roomId) => r.memberIds.all(roomId).map((x) => x.user_id),
    ownedPrivateCount: (userId) => r.ownedPrivate.get(userId).n,
    isRoomBanned: (roomId, userId) => !!r.isBanned.get(roomId, userId),
    setTopic: (roomId, topic) => r.setTopic.run(topic, roomId),
    closeRoom: (roomId) => r.del.run(roomId),

    createRoom: tx(({ kind, name, topic, ownerId }) => {
      const norm = normalizeScreenName(name);
      if (kind === 'public' && r.publicByNorm.get(norm)) return { error: 'taken' };
      const id = Number(r.insert.run(kind, name, norm, topic).lastInsertRowid);
      r.addMember.run(id, ownerId, 'member', 'owner');
      return { id };
    }),

    joinPublic: (roomId, userId) => r.addMember.run(roomId, userId, 'member', 'member'),

    inviteToRoom: tx((roomId, inviterId, inviteeId, epoch, envelope) => {
      const room = r.get.get(roomId);
      if (room.key_epoch !== epoch || r.keyCount.get(roomId, epoch).n === 0) return { error: 'rekey' };
      r.addMember.run(roomId, inviteeId, 'invited', 'member');
      r.insertKey.run(roomId, inviteeId, epoch, inviterId, envelope);
      return {};
    }),

    acceptRoomInvite: (roomId, userId) => r.setStatus.run('member', roomId, userId),

    // Leave, decline, kick. Returns what changed so callers can notify people.
    leaveRoom: tx((roomId, userId, { ban = false } = {}) => {
      const room = r.get.get(roomId);
      const m = r.membership.get(roomId, userId);
      if (!room || !m) return null;
      r.removeMember.run(roomId, userId);
      if (ban) r.ban.run(roomId, userId);
      if (room.kind === 'public') return { deleted: false };
      return afterPrivateDeparture(roomId, m.role === 'owner');
    }),

    // Store a freshly generated room key, wrapped for every current member and invitee.
    submitRekey: tx((roomId, wrapperId, epoch, entries) => {
      const room = r.get.get(roomId);
      if (!room || room.key_epoch !== epoch) return { error: 'stale' };
      if (r.keyCount.get(roomId, epoch).n > 0) return { error: 'exists' };
      const holders = new Set(r.keyHolders.all(roomId).map((x) => x.user_id));
      const given = new Set(entries.map((e) => e.userId));
      if (holders.size !== given.size || [...holders].some((id) => !given.has(id))) return { error: 'members' };
      for (const e of entries) r.insertKey.run(roomId, e.userId, epoch, wrapperId, e.envelope);
      return {};
    }),

    myRoomKey: (roomId, userId, epoch) => r.myKey.get(roomId, userId, epoch),
    roomHasKey: (roomId, epoch) => r.keyCount.get(roomId, epoch).n > 0,

    purgeExpired() {
      const now = Date.now();
      s.purgeSessions.run(now);
      s.purgeInvites.run(now);
      s.purgeOffline.run(now);
    },
  };
}
