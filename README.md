# Mem Messenger

A late-90s instant messenger for you and your friends. It has a buddy list, away messages, door-creak sign-on sounds and "is typing…". Messages are **end-to-end encrypted**, and signing up needs **no email and no real name**.

- **Screen name + password only.** No email, phone number or real name, ever.
- **Invite-only.** New people need an invite code: a personal one from a member, or a campaign code you post (e.g. in an Instagram story).
- **End-to-end encrypted.** IMs and private chat rooms are encrypted in the browser. The server only relays ciphertext it can't read.
- **Chat rooms.** Public rooms anyone can join, and invite-only private rooms that are end-to-end encrypted.
- **No chat history.** Conversations live only in the open window. Closing it erases them.
- **Minimal data.** No analytics, trackers, third-party scripts, fonts or CDNs. The server keeps no logs of IPs or messages.

## On your phone

Open the site in Safari (iPhone) or Chrome (Android) and choose **Share → Add to Home Screen** (iPhone) or **⋮ → Add to Home screen / Install app** (Android). It then opens full-screen like a regular app.

On phones, every window fills the screen:

- Tap a buddy to open a chat.
- Use **‹** or your phone's Back gesture to return to the Buddy List. Back never signs you off.
- New messages show a small banner and a red unread count instead of covering what you're doing.

## Chat rooms

Tap **Chat** in the Buddy List to see the room list.

| | Public rooms | Private rooms |
|---|---|---|
| Who creates them | Admins | Anyone |
| Who can join | Anyone, from the room list | Buddies the members invite |
| Encryption | HTTPS in transit only; the server relays the text | End-to-end; the server only sees ciphertext |
| Moderation | Admins can set the topic, remove people, close the room | The owner can do the same |
| Size | No fixed limit | Up to 50 people |

- Rooms you're in appear under **Chat Rooms** on your Buddy List, with an unread count. You're "in" them whenever you're signed on.
- Nothing is saved. You see what's said while you're signed on, and closing the room window erases it. Leaving a room is a separate button under **Options**.
- Mentioning someone's screen name (`@Bob Dog` or just `Bob Dog`) highlights the message for them, plays a sound, and shows a banner on phones.
- Tap a name in a room's member list to IM them, add them as a buddy, or (moderators) remove them. Removed people can't rejoin that room.
- Messages from people you've blocked are hidden in rooms.

## Letting your followers sign up (campaign codes)

A campaign code is one invite code that many people can use, with a limit on sign-ups and an expiry. Post it where your audience is, such as an Instagram story.

**In the app (admins):** go to **Setup → Admin Tools**, or **Invite → Make a campaign code**.

1. Type a code like `MEM-DROP`, or leave it blank for a random, harder-to-guess one.
2. Pick the maximum sign-ups and how long it lasts (24 hours to 1 year), then **Create Code**.
3. **Copy Link + Code** gives you the site address and code together, ready to paste into a story.

Your codes are listed with live sign-up counts, and **Revoke** stops a code instantly if it spreads further than you wanted. Personal single-use invites from the **Invite** button keep working alongside campaign codes.

Sign-ups are limited to 30 per IP address per hour (`REGISTRATIONS_PER_HOUR`). The limit is set this high because many phones on the same carrier can share one IP.

## Admins

| | Owner (`mem`) | Admins | Everyone |
|---|---|---|---|
| Make / revoke campaign codes | ✓ | ✓ | |
| Create and moderate public rooms | ✓ | ✓ | |
| Make someone an admin, or remove one | ✓ | | |

- **The owner** is any screen name in `ADMIN_SCREEN_NAMES` (default `mem`). Owners are always admins and add or remove admins in **Setup → Admin Tools → Admins**. The change reaches the person immediately; they don't need to sign on again.
- **Owner names are reserved.** They can only be registered with an admin-issued single-use code: the first-run code in the deploy logs, or `npm run invite`. A campaign code or a friend's invite can't claim them.
- **The very first account** ever created is also an admin.

## Deploy on Railway

1. In Railway choose **New Project → Deploy from GitHub repo** and pick this repo.
2. **Attach a Volume** to the service and mount it at `/data`.
   The SQLite database lives there. Without a volume, every deploy wipes all accounts, and the logs warn you about it.
3. Under **Settings → Networking**, click **Generate Domain** (or attach your own domain).
4. Open the **Deploy Logs**. On first start the server prints a one-time invite code:
   ```
   No accounts yet. Use this one-time invite code to create the first screen name:
       K7QM-2XPA-9RTF-HB3C
   ```
5. Visit your domain, click **Get a Screen Name**, and use that code to create **`mem`**. It's the owner automatically (see *Admins* above).
   After that, generate invites for friends from the **Invite** button, or make a campaign code (see above).

No environment variables are required. The app detects Railway and then:

- listens on `0.0.0.0`
- trusts Railway's HTTPS proxy for client IPs, which rate limiting uses
- stores data on the attached volume (`RAILWAY_VOLUME_MOUNT_PATH`)
- uses `Secure` cookies

Railway handles HTTPS. `railway.json` sets the start command and a `/healthz` health check.

### Optional settings

| Variable | Default | Meaning |
|---|---|---|
| `OFFLINE_MESSAGE_TTL_DAYS` | `7` | How long encrypted messages for offline buddies are kept. `0` = only deliver to people who are online (classic AIM). |
| `SESSION_TTL_HOURS` | `24` | Sign-on session lifetime. |
| `INVITES_PER_USER` | `5` | Max unused invite codes per person. |
| `INVITE_TTL_DAYS` | `7` | Invite code lifetime. |
| `REGISTRATIONS_PER_HOUR` | `30` | Sign-ups allowed per IP per hour. |
| `ADMIN_SCREEN_NAMES` | `mem` | Comma-separated screen names that are always admins and reserved for admin-issued invites. Set to empty to turn off. |
| `ALLOWED_ORIGINS` | *(same host)* | Comma-separated origins allowed to call the API, if you serve from several domains. |

### Admin commands

Everything here can also be done in the app (Setup → Admin Tools). For a shell on the server, use `railway ssh` (it needs an SSH key: `ssh-keygen -t ed25519`), then:

```sh
npm run invite                              # print a fresh single-use invite code
npm run admin -- campaign CODE --uses N --hours H   # reusable campaign code
npm run admin -- campaigns                  # list campaign codes and sign-up counts
npm run admin -- revoke CODE                # stop a code working
npm run admin -- users                      # list screen names (* = admin)
npm run admin -- make-admin "Screen Name"   # or remove-admin
npm run admin -- delete-user "Screen Name"  # delete a user and all their data
```

## Run locally

Requires Node 22.13+.

```sh
npm install
npm run dev     # http://127.0.0.1:3000 (the invite code is printed in the terminal)
npm test
```

`npm run dev` turns off `Secure` cookies so plain `http://localhost` works. Don't expose dev mode to the internet.

## How the security works

**Your password never leaves your browser.**
- The browser stretches it with PBKDF2-SHA256 (600,000 iterations) and splits the result with HKDF into two keys:
  - An **auth key** is sent as the login credential. The server hashes it again with scrypt before storing it.
  - A **wrap key** never leaves the browser.
- On sign-up the browser generates an ECDH P-256 **identity key pair**. The server stores the public key and a copy of the private key encrypted with the wrap key. It can't decrypt that copy.
- On sign-on the browser downloads the encrypted private key and decrypts it locally. The key is held in memory as a non-extractable WebCrypto key. Reloading the page signs you off, just like closing AIM.

**Messages**
- Each pair of buddies derives a shared secret with ECDH.
- Every message is encrypted with a fresh AES-256-GCM key (HKDF with a random salt).
- The sender, recipient and message ID are authenticated along with the ciphertext, so the server can't re-route or re-label messages undetected.
- The server checks that sender and recipient are mutual buddies, then forwards the ciphertext.
- If the recipient is offline, the ciphertext is queued (7 days by default) and deleted as soon as it's delivered.

**Verifying buddies (safety numbers)**
- Click the 🔒 badge in an IM window to see a 60-digit safety number. It's the same on both screens.
- Compare it with your friend in person or on a call. If it matches, even a malicious server can't read your messages.
- Your browser also *pins* each buddy's key the first time it sees it. Keys never change in this app, so if the server ever serves a different key, the IM window shows a red warning and refuses to send or display messages until you re-verify.

**Server hardening**
- Strict Content-Security-Policy with no inline scripts. All user text is inserted as text, never HTML.
- `HttpOnly`, `SameSite=Strict`, `Secure`, `__Host-` session cookies, plus Origin checks on every state-changing request and WebSocket handshake.
- Rate limits on sign-on, sign-up and messages. Request size limits. No path traversal.
- Presence and away messages are held in memory only. The database uses `secure_delete`.
- Only one runtime dependency (`ws`); the database is Node's built-in SQLite.

**Private chat rooms**
- Each private room has a random 256-bit room key.
- Whoever creates the key encrypts a separate copy to each member, using the same pairwise scheme as IMs. The server stores only those encrypted copies.
- Room messages use AES-256-GCM with a fresh key per message. The room, key version, sender and message ID are authenticated along with the text.
- When anyone leaves or is removed, the old key is retired. A new key is generated for the remaining members, so people who left can't read what's said afterwards, even with the server's help.
- If a member is also your buddy, their key is checked against the one pinned on your device before a room key is shared with them.

**Public chat rooms** are protected by HTTPS but are *not* end-to-end encrypted: the server relays the text. It is never written to disk or logged.

### Honest limitations

- **No password reset.** There's no email to reset with, and the password protects your encryption key. A forgotten password means a new account.
- **No forward secrecy.** The design uses long-term keys, not a Signal-style ratchet. Someone who later steals both your password *and* the server database could decrypt messages they had previously captured in transit or in the offline queue.
- **Visible to the server:** who is buddies with whom, who is in which room, when people are online, the timing and size of messages, away messages, and public-room messages.
- **Private rooms with non-buddies:** you can't compare safety numbers with room members who aren't your buddies. For them, you trust the server to hand out their real keys. Add people as buddies and verify them if that matters.
- **You trust the server for the code.** Like any web app, a compromised server could serve malicious JavaScript. Keep your Railway and GitHub accounts protected with 2FA.
- It's built for a small group of friends, not thousands of users.
