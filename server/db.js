import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  norm        TEXT NOT NULL UNIQUE,
  display     TEXT NOT NULL,
  auth_salt   TEXT NOT NULL,
  auth_hash   TEXT NOT NULL,
  public_key  TEXT NOT NULL,
  wrapped_key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS invites (
  code_hash  TEXT PRIMARY KEY,
  created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS buddies (
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  buddy_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL DEFAULT 'Buddies',
  PRIMARY KEY (owner_id, buddy_id)
);
CREATE TABLE IF NOT EXISTS buddy_requests (
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (from_id, to_id)
);
CREATE TABLE IF NOT EXISTS blocks (
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (owner_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS offline_messages (
  id         INTEGER PRIMARY KEY,
  to_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  msg_id     TEXT NOT NULL,
  envelope   TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS offline_to ON offline_messages(to_id);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
  db.exec(SCHEMA);
  if (file !== ':memory:') {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }
  return db;
}
