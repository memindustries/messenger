# Buddy Messenger

A late-90s instant messenger for you and your friends. It has a buddy list, away messages, door-creak sign-on sounds and "is typing…". Messages are **end-to-end encrypted**, and signing up needs **no email and no real name**.

- **Screen name + password only.** No email, phone number or real name, ever.
- **Invite-only.** New people need a single-use invite code from an existing member.
- **End-to-end encrypted.** Messages are encrypted in the browser. The server only relays ciphertext it can't read.
- **No chat history.** Conversations live only in the open IM window. Closing it erases them.
- **Minimal data.** No analytics, trackers, third-party scripts, fonts or CDNs. The server keeps no logs of IPs or messages.

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
5. Visit your domain, click **Get a Screen Name**, and use that code.
   After that, generate invites for friends from the **Invite** button in the Buddy List.

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
| `REGISTRATIONS_PER_HOUR` | `10` | Sign-ups allowed per IP per hour. |
| `ALLOWED_ORIGINS` | *(same host)* | Comma-separated origins allowed to call the API, if you serve from several domains. |

### Admin commands

From a shell on the server (`railway ssh`), or locally against your own data directory:

```sh
npm run invite                              # print a fresh invite code
npm run admin -- users                      # list screen names
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

### Honest limitations

- **No password reset.** There's no email to reset with, and the password protects your encryption key. A forgotten password means a new account.
- **No forward secrecy.** The design uses long-term keys, not a Signal-style ratchet. Someone who later steals both your password *and* the server database could decrypt messages they had previously captured in transit or in the offline queue.
- **Visible to the server:** who is buddies with whom, when people are online, the timing and size of messages, and away messages, which are not end-to-end encrypted.
- **You trust the server for the code.** Like any web app, a compromised server could serve malicious JavaScript. Keep your Railway and GitHub accounts protected with 2FA.
- It's built for a small group of friends, not thousands of users.
