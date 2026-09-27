// Admin commands, run on the server:  npm run admin -- <command>
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createStore } from './store.js';

const config = loadConfig();
const store = createStore(openDb(config.dbFile));
const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case 'invite': {
    const { code, expiresAt } = store.createInvite(null, config.inviteTtlMs);
    console.log(`Invite code: ${code}  (single use, expires ${new Date(expiresAt).toISOString()})`);
    break;
  }
  case 'users':
    for (const u of store.listUsers()) console.log(u.display);
    break;
  case 'delete-user': {
    const u = arg && store.userByName(arg);
    if (!u) {
      console.error('No such user.');
      process.exit(1);
    }
    store.deleteUser(u.id);
    console.log(`Deleted ${u.display} and all of their data.`);
    break;
  }
  default:
    console.log('Commands: invite | users | delete-user <screen name>');
}
