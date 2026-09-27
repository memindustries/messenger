// Admin commands, run on the server:  npm run admin -- <command>
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createStore, newInviteCode, normalizeInvite } from './store.js';

const config = loadConfig();
const store = createStore(openDb(config.dbFile));
const [cmd, ...args] = process.argv.slice(2);

function flag(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
}

function user(name) {
  const u = name && store.userByName(name);
  if (!u) {
    console.error('No such user.');
    process.exit(1);
  }
  return u;
}

const HELP = `Commands:
  invite                               one single-use invite code (7 days)
  campaign [CODE] [--uses N] [--hours H]
                                       reusable code for a story/post, e.g.
                                       campaign MEM-DROP --uses 300 --hours 48
                                       (omit CODE for a random one)
  campaigns                            list campaign codes and how many signed up
  revoke <CODE>                        stop a code working immediately
  users                                list screen names (admins marked *)
  make-admin <screen name>             let someone create/moderate public rooms
  remove-admin <screen name>
  delete-user <screen name>            delete a user and all their data`;

switch (cmd) {
  case 'invite': {
    const { code, expiresAt } = store.createInvite(null, config.inviteTtlMs);
    console.log(`Invite code: ${code}  (single use, expires ${new Date(expiresAt).toISOString()})`);
    break;
  }
  case 'campaign': {
    const custom = args[0] && !args[0].startsWith('--') ? args[0].toUpperCase() : null;
    if (custom && normalizeInvite(custom).length < 6) {
      console.error('Use at least 6 letters/numbers so the code is hard to guess.');
      process.exit(1);
    }
    const uses = Math.max(1, Math.floor(Number(flag('uses', 100))) || 100);
    const hours = Math.max(1, Number(flag('hours', 48)) || 48);
    const { code, maxUses, expiresAt } = store.createCampaign(custom || newInviteCode(), uses, hours * 3600_000);
    console.log(`Campaign code: ${code}`);
    console.log(`  up to ${maxUses} sign-ups, expires ${new Date(expiresAt).toISOString()}`);
    break;
  }
  case 'campaigns': {
    const rows = store.campaigns();
    if (!rows.length) console.log('No campaign codes.');
    for (const c of rows) {
      const state = c.expires_at <= Date.now() ? 'expired' : c.uses >= c.max_uses ? 'used up' : 'active';
      console.log(`${c.label.padEnd(22)} ${String(c.uses).padStart(5)}/${c.max_uses} used  ${state.padEnd(8)} until ${new Date(c.expires_at).toISOString()}`);
    }
    break;
  }
  case 'revoke':
    console.log(args[0] && store.revokeInvite(args[0]) ? 'Revoked.' : 'No such code.');
    break;
  case 'users':
    for (const u of store.listUsers()) console.log(`${store.userById(u.id).is_admin ? '*' : ' '} ${u.display}`);
    break;
  case 'make-admin':
  case 'remove-admin': {
    const u = user(args.join(' '));
    store.setAdmin(u.id, cmd === 'make-admin');
    console.log(`${u.display} is ${cmd === 'make-admin' ? 'now' : 'no longer'} an admin. (Their app shows admin controls after they next sign on.)`);
    break;
  }
  case 'delete-user': {
    const u = user(args.join(' '));
    // Hands off room ownership and retires private-room keys they held.
    for (const room of store.userRooms(u.id)) store.leaveRoom(room.id, u.id);
    store.deleteUser(u.id);
    console.log(`Deleted ${u.display} and all of their data.`);
    break;
  }
  default:
    console.log(HELP);
}
