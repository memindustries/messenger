import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

function num(v, dflt) {
  const n = Number(v);
  return v === undefined || v === '' || Number.isNaN(n) ? dflt : n;
}

export function loadConfig(env = process.env) {
  const dev = env.NODE_ENV === 'development';
  // On Railway: TLS is terminated by Railway's edge proxy, the app must listen on
  // all interfaces, and the SQLite database must live on an attached Volume.
  const railway = !!env.RAILWAY_ENVIRONMENT_NAME || !!env.RAILWAY_ENVIRONMENT;
  const dataDir = path.resolve(root, env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || 'data');
  return {
    dev,
    railway,
    hasVolume: !railway || !!(env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH),
    host: env.HOST || (railway ? '0.0.0.0' : '127.0.0.1'),
    port: num(env.PORT, 3000),
    dataDir,
    dbFile: env.DB_FILE || path.join(dataDir, 'messenger.db'),
    publicDir: path.join(root, 'public'),
    // Cookies are Secure (HTTPS-only) unless running in development mode.
    cookieSecure: bool(env.COOKIE_SECURE, !dev),
    // Only honour X-Forwarded-For when running behind a reverse proxy you control.
    trustProxy: bool(env.TRUST_PROXY, railway),
    // Comma-separated list of allowed browser origins. Empty = same host as request.
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    sessionTtlMs: num(env.SESSION_TTL_HOURS, 24) * 3600_000,
    // Encrypted messages for offline buddies are held this long, then deleted. 0 disables.
    offlineTtlMs: num(env.OFFLINE_MESSAGE_TTL_DAYS, 7) * 86400_000,
    maxOfflinePerUser: num(env.MAX_OFFLINE_PER_USER, 500),
    registrationsPerHourPerIp: num(env.REGISTRATIONS_PER_HOUR, 10),
    invitesPerUser: num(env.INVITES_PER_USER, 5),
    inviteTtlMs: num(env.INVITE_TTL_DAYS, 7) * 86400_000,
  };
}
