import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createStore } from './store.js';

const config = loadConfig();

if (config.railway && !config.hasVolume) {
  console.warn('WARNING: No Railway Volume attached. The database will be wiped on every deploy.');
  console.warn('         Add a Volume to this service (mount path e.g. /data).');
}

const db = openDb(config.dbFile);
const app = createApp({ config, db });

// First run: nobody can sign up without an invite, so print one to the logs.
const store = createStore(db);
if (store.userCount() === 0 && store.countAllInvites() === 0) {
  const { code } = store.createInvite(null, config.inviteTtlMs);
  console.log('');
  console.log('  No accounts yet. Use this one-time invite code to create the first screen name:');
  console.log(`      ${code}`);
  console.log('  (Generate more later from inside the app, or with `npm run invite`.)');
  console.log('');
}

app.server.listen(config.port, config.host, () => {
  console.log(`Mem Messenger listening on http://${config.host}:${config.port}`);
  if (!config.cookieSecure) console.log('Development mode: cookies are not marked Secure. Do not expose this to the internet.');
});

function shutdown() {
  app.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
