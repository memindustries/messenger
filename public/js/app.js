import * as C from './crypto.js';
import { sounds, unlockAudio, setSoundEnabled } from './sounds.js';

// ===========================================================================
// Small helpers

const MAX_TEXT = 4000;
const OFFLINE_MAX_AGE = 8 * 86400_000;
const APP_NAME = document.getElementById('app-name')?.textContent || 'Mem Messenger';

// Element builder. User-provided strings only ever become text nodes.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const prefs = {
  get(key, dflt) {
    try {
      const v = localStorage.getItem(`bm:${key}`);
      return v === null ? dflt : JSON.parse(v);
    } catch {
      return dflt;
    }
  },
  set(key, value) {
    try {
      if (value === undefined) localStorage.removeItem(`bm:${key}`);
      else localStorage.setItem(`bm:${key}`, JSON.stringify(value));
    } catch { /* storage may be disabled */ }
  },
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const timeFmt = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ===========================================================================
// Window manager

const desktop = document.getElementById('desktop');
const tasks = document.getElementById('tasks');
const windows = new Set();
let zTop = 10;
let cascade = 0;
// Keep in sync with the "small screen" media query in aim.css.
const SMALL_MQ = matchMedia('(max-width: 640px), (max-height: 500px) and (pointer: coarse)');
const COARSE_MQ = matchMedia('(pointer: coarse)');
const isSmall = () => SMALL_MQ.matches;
const isTouch = () => SMALL_MQ.matches || COARSE_MQ.matches;

function topWindow() {
  let top = null;
  for (const w of windows) {
    if (w.visible && (!top || Number(w.el.style.zIndex) > Number(top.el.style.zIndex))) top = w;
  }
  return top;
}

// back: what the mobile "‹" button does ('minimize' keeps the window, 'close' removes it).
function makeWindow({
  title, taskLabel = title, cls = '', icon = '/img/buddy.svg', x, y,
  onClose, onFocus, closable = true, task = true, back = null, background = false,
}) {
  const titleEl = h('span', { class: 'title', text: title });
  const backBtn = back ? h('button', { type: 'button', class: 'back', 'aria-label': 'Back', text: '‹' }) : null;
  const minBtn = h('button', { type: 'button', class: 'min', 'aria-label': 'Minimize', text: '_' });
  const closeBtn = closable ? h('button', { type: 'button', 'aria-label': 'Close', text: '×' }) : null;
  const bar = h('div', { class: 'titlebar' }, backBtn, h('img', { src: icon, alt: '' }), titleEl, minBtn, closeBtn);
  const body = h('div', { class: 'window-body' });
  // Let callers pass optional sections as null/false, like h() allows.
  const nativeAppend = body.append.bind(body);
  body.append = (...nodes) => nativeAppend(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
  const el = h('section', { class: `window ${cls}`, role: 'dialog', 'aria-label': title }, bar, body);
  const taskBtn = task ? h('button', { class: 'task', type: 'button', text: taskLabel }) : null;

  const win = {
    el, body, taskBtn,
    setTitle(t) {
      titleEl.textContent = t;
      el.setAttribute('aria-label', t);
    },
    setTaskLabel(t) {
      if (taskBtn) taskBtn.textContent = t;
    },
    focus() {
      el.classList.remove('hidden');
      el.style.zIndex = String(++zTop);
      for (const w of windows) {
        w.el.classList.toggle('inactive', w !== win);
        w.taskBtn?.classList.toggle('active', w === win);
      }
      taskBtn?.classList.remove('flash');
      onFocus?.();
    },
    minimize() {
      el.classList.add('hidden');
      taskBtn?.classList.remove('active');
      topWindow()?.focus();
    },
    back() {
      if (back === 'close') win.close();
      else win.minimize();
    },
    flash() {
      if (!win.active) taskBtn?.classList.add('flash');
    },
    close() {
      if (!windows.has(win)) return;
      windows.delete(win);
      el.remove();
      taskBtn?.remove();
      onClose?.();
      topWindow()?.focus();
    },
    get visible() {
      return !el.classList.contains('hidden');
    },
    // Visible, frontmost, and the page itself is being looked at.
    get active() {
      return win.visible && !el.classList.contains('inactive') && !document.hidden;
    },
  };

  backBtn?.addEventListener('click', () => win.back());
  minBtn.addEventListener('click', () => win.minimize());
  closeBtn?.addEventListener('click', () => win.close());
  el.addEventListener('pointerdown', () => { if (!win.active) win.focus(); });
  taskBtn?.addEventListener('click', () => {
    if (win.active && !isSmall()) win.minimize();
    else win.focus();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && closable && cls.includes('dialog')) win.close();
  });

  // Dragging by the title bar.
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || isSmall()) return;
    const startX = e.clientX - el.offsetLeft;
    const startY = e.clientY - el.offsetTop;
    bar.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const maxX = desktop.clientWidth - 60;
      const maxY = desktop.clientHeight - 30;
      el.style.left = `${Math.min(maxX, Math.max(-el.offsetWidth + 80, ev.clientX - startX))}px`;
      el.style.top = `${Math.min(maxY, Math.max(0, ev.clientY - startY))}px`;
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });

  desktop.append(el);
  if (taskBtn) tasks.append(taskBtn);
  windows.add(win);
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  const left = x ?? Math.max(0, (desktop.clientWidth - w) / 2 + ((cascade % 6) * 24 - 60));
  const top = y ?? Math.max(0, (desktop.clientHeight - hgt) / 3 + ((cascade % 6) * 24 - 40));
  cascade++;
  el.style.left = `${Math.min(left, Math.max(0, desktop.clientWidth - w))}px`;
  el.style.top = `${Math.min(top, Math.max(0, desktop.clientHeight - hgt))}px`;
  // Windows that grow after opening (content loading in) slide up to stay on screen.
  new ResizeObserver(() => {
    if (isSmall()) return;
    const overflow = el.offsetTop + el.offsetHeight - desktop.clientHeight;
    if (overflow > 0) el.style.top = `${Math.max(0, el.offsetTop - overflow)}px`;
  }).observe(el);
  if (background && isSmall()) {
    // On phones every window is full-screen, so never cover what the user is doing.
    el.classList.add('hidden', 'inactive');
    el.style.zIndex = '1';
    taskBtn?.classList.add('flash');
  } else {
    win.focus();
  }
  return win;
}

// Only one instance of each dialog at a time.
const dialogs = new Map();
function dialog(key, opts, build) {
  const existing = dialogs.get(key);
  if (existing) {
    existing.focus();
    return existing;
  }
  const win = makeWindow({ cls: 'dialog', back: 'close', ...opts, onClose: () => dialogs.delete(key) });
  dialogs.set(key, win);
  build(win);
  if (!isTouch()) win.body.querySelector('input, textarea, select, button')?.focus();
  return win;
}

function alertBox(title, message) {
  const win = makeWindow({ title, cls: 'dialog', back: 'close' });
  const ok = h('button', { type: 'button', text: 'OK', onclick: () => win.close() });
  win.body.append(h('p', { text: message }), h('div', { class: 'row end' }, ok));
  ok.focus();
}

// Clock in the taskbar.
const clock = document.getElementById('clock');
const tick = () => { clock.textContent = timeFmt(Date.now()); };
tick();
setInterval(tick, 15_000);

// Size the app to the *visible* viewport so the on-screen keyboard never hides
// the message box, and hide the taskbar while typing on a phone.
const vv = window.visualViewport;
let fullHeight = 0;
let lastWidth = 0;
function fitViewport() {
  const height = vv ? vv.height : window.innerHeight;
  const width = vv ? vv.width : window.innerWidth;
  if (width !== lastWidth) {
    fullHeight = 0; // rotated
    lastWidth = width;
  }
  fullHeight = Math.max(fullHeight, height);
  const root = document.documentElement.style;
  root.setProperty('--app-h', `${Math.round(height)}px`);
  root.setProperty('--app-top', `${Math.round(vv ? vv.offsetTop : 0)}px`);
  document.body.classList.toggle('kb-open', isTouch() && height < fullHeight * 0.8);
}
vv?.addEventListener('resize', fitViewport);
vv?.addEventListener('scroll', fitViewport);
window.addEventListener('resize', fitViewport);
fitViewport();

// Small tappable notice, used on phones instead of popping a window over you.
function toast(text, onclick) {
  document.querySelector('.toast')?.remove();
  const el = h('button', { type: 'button', class: 'toast', text });
  const remove = () => el.remove();
  el.addEventListener('click', () => {
    remove();
    onclick?.();
  });
  document.body.append(el);
  setTimeout(remove, 6000);
}

// The browser's Back button / swipe would leave the page, which signs you off
// (keys only live in memory). While signed on, Back closes the top window instead.
function armBackTrap() {
  history.pushState({ bm: true }, '');
}
window.addEventListener('popstate', () => {
  if (!S) return;
  const top = topWindow();
  if (top && top !== S.buddyWin) top.back();
  armBackTrap();
});

// ===========================================================================
// Session state (memory only; nothing decrypted is ever written to disk)

let S = null;

function newState(me) {
  return {
    me, // { screenName, norm, publicKey, wrappedKey, privateKey }
    buddies: new Map(), // norm -> buddy
    incoming: [],
    outgoing: [],
    blocked: [],
    ims: new Map(), // norm -> IM window controller
    convKeys: new Map(), // norm -> { pub, key: Promise<CryptoKey> }
    pending: new Map(), // msg id -> norm
    seen: new Set(),
    delivered: [],
    deliveredTimer: null,
    away: { on: false, message: '' },
    autoReplied: new Set(),
    unread: new Map(), // norm -> count of unseen messages
    rooms: new Map(), // room id -> { id, kind, name, topic, role, online, unread, mention }
    roomInvites: [], // [{ id, name, from }]
    roomLogs: new Map(), // room id -> recent lines, in memory only
    roomWins: new Map(), // room id -> room window controller
    roomKeys: new Map(), // room id -> { epoch, raw, key }
    roomPending: new Map(), // msg id -> { room, text, retried }
    collapsed: new Set(prefs.get('collapsed', [])),
    selected: null,
    ws: null,
    wsRetry: 0,
    wsTimer: null,
    signingOff: false,
    buddyWin: null,
  };
}

// ---- Key pinning (trust on first use) -------------------------------------

function pinsKey() {
  return `pins:${S.me.norm}`;
}

async function checkPin(b) {
  const pins = prefs.get(pinsKey(), {});
  const fp = await C.keyFingerprint(b.publicKey);
  const pin = pins[b.norm];
  if (!pin) {
    pins[b.norm] = { fp, verified: false };
    prefs.set(pinsKey(), pins);
    b.keyStatus = 'ok';
  } else if (pin.fp !== fp) {
    b.keyStatus = 'changed';
  } else {
    b.keyStatus = pin.verified ? 'verified' : 'ok';
  }
}

function setPin(b, verified) {
  return C.keyFingerprint(b.publicKey).then((fp) => {
    const pins = prefs.get(pinsKey(), {});
    pins[b.norm] = { fp, verified };
    prefs.set(pinsKey(), pins);
    b.keyStatus = verified ? 'verified' : 'ok';
    refreshBuddy(b);
  });
}

function convKey(b) {
  const cached = S.convKeys.get(b.norm);
  if (cached && cached.pub === b.publicKey) return cached.key;
  const key = C.deriveConversationKey(S.me.privateKey, b.publicKey);
  S.convKeys.set(b.norm, { pub: b.publicKey, key });
  return key;
}

// ===========================================================================
// Sign on / registration

function showSignOn(notice) {
  document.title = APP_NAME;
  const win = makeWindow({ title: 'Sign On', cls: 'signon', closable: false });
  let mode = 'signin';

  const name = h('input', { type: 'text', autocomplete: 'username', maxlength: '20', required: true, spellcheck: 'false', autocapitalize: 'off' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const pass2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const invite = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', placeholder: 'XXXX-XXXX-XXXX-XXXX' });
  const save = h('input', { type: 'checkbox' });
  const saved = prefs.get('screenName', '');
  if (saved) {
    name.value = saved;
    save.checked = true;
  }
  const status = h('div', { class: 'status-line', role: 'status' });
  const steps = h('div', { class: 'steps' }, h('span', { text: '1' }), h('span', { text: '2' }), h('span', { text: '3' }));
  const submit = h('button', { type: 'submit', text: 'Sign On' });
  const toggle = h('button', { type: 'button', class: 'linkish' });
  const regFields = h('div', { class: 'field' },
    h('label', { class: 'field' }, 'Confirm Password', pass2),
    h('label', { class: 'field' }, 'Invite Code', invite),
    h('p', { class: 'hint', text: 'No email or real name needed. There is no password reset: if you forget your password, the account (and its encryption keys) cannot be recovered.' }));

  const setStep = (n, text) => {
    [...steps.children].forEach((s, i) => s.classList.toggle('on', i < n));
    status.className = 'status-line';
    status.textContent = text;
  };
  const setMode = (m) => {
    mode = m;
    regFields.hidden = m !== 'register';
    submit.textContent = m === 'register' ? 'Create Screen Name' : 'Sign On';
    toggle.textContent = m === 'register' ? 'I already have a screen name' : 'Get a Screen Name';
    pass.autocomplete = m === 'register' ? 'new-password' : 'current-password';
    win.setTitle(m === 'register' ? 'New Screen Name' : 'Sign On');
    status.textContent = '';
  };
  toggle.addEventListener('click', () => setMode(mode === 'register' ? 'signin' : 'register'));

  const form = h('form', { novalidate: true },
    h('label', { class: 'field' }, 'Screen Name', name),
    h('label', { class: 'field' }, 'Password', pass),
    regFields,
    h('label', { class: 'check' }, save, 'Save screen name'),
    h('div', { class: 'row' }, toggle, h('span', { class: 'grow' }), submit),
    steps, status);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    unlockAudio();
    const screenName = name.value.trim().replace(/\s+/g, ' ');
    const password = pass.value;
    const fail = (msg) => {
      status.className = 'status-line error';
      status.textContent = msg;
      [...steps.children].forEach((s) => s.classList.remove('on'));
      submit.disabled = false;
    };
    if (!screenName || !password) return fail('Enter a screen name and password.');
    if (mode === 'register') {
      if (!/^[A-Za-z][A-Za-z0-9 ]{2,19}$/.test(screenName) || C.normalizeScreenName(screenName).length > 16) {
        return fail('Screen names: 3-16 letters/numbers, starting with a letter.');
      }
      if (password.length < 10) return fail('Use a password of at least 10 characters.');
      if (password !== pass2.value) return fail("Passwords don't match.");
      if (!invite.value.trim()) return fail('You need an invite code from a friend.');
    }
    submit.disabled = true;
    try {
      setStep(1, 'Securing password…');
      const keys = await C.deriveAccountKeys(screenName, password);
      let me;
      if (mode === 'register') {
        setStep(2, 'Generating encryption keys…');
        const id = await C.generateIdentity(keys.wrapKey, keys.norm);
        const reg = await api('POST', '/api/register', {
          screenName, inviteCode: invite.value.trim(), authKey: keys.authKey,
          publicKey: id.publicKey, wrappedKey: id.wrappedKey,
        });
        me = { screenName, norm: keys.norm, publicKey: id.publicKey, wrappedKey: id.wrappedKey, privateKey: id.privateKey, isAdmin: reg.isAdmin, isOwner: reg.isOwner };
      } else {
        setStep(2, 'Verifying password…');
        const r = await api('POST', '/api/login', { screenName, authKey: keys.authKey });
        setStep(3, 'Unlocking encryption keys…');
        const privateKey = await C.unwrapIdentity(r.wrappedKey, keys.wrapKey, keys.norm);
        me = { screenName: r.screenName, norm: keys.norm, publicKey: r.publicKey, wrappedKey: r.wrappedKey, privateKey, isAdmin: r.isAdmin, isOwner: r.isOwner };
      }
      prefs.set('screenName', save.checked ? me.screenName : undefined);
      pass.value = '';
      pass2.value = '';
      win.close();
      startSession(me);
    } catch (err) {
      fail(err.message || 'Could not sign on.');
    }
  });

  win.body.append(
    h('div', { class: 'hero sunken' },
      h('img', { src: '/img/buddy.svg', alt: '' }),
      h('div', { class: 'brand', text: APP_NAME }),
      h('div', { class: 'tag', text: '🔒 End-to-end encrypted · friends only' })),
    form);
  setMode('signin');
  if (notice) {
    status.className = 'status-line error';
    status.textContent = notice;
  }
  if (!isTouch()) (saved ? pass : name).focus();
}

// ===========================================================================
// Main session

async function startSession(me) {
  S = newState(me);
  setSoundEnabled(prefs.get('sounds', true));
  document.title = `${me.screenName} - ${APP_NAME}`;
  buildBuddyList();
  armBackTrap();
  try {
    await loadBuddies();
    await loadRooms();
  } catch (err) {
    if (err.status === 401) return signOff('Please sign on again.');
  }
  connect();
}

async function signOff(notice, { skipServer = false } = {}) {
  if (!S) return;
  const state = S;
  state.signingOff = true;
  clearTimeout(state.wsTimer);
  state.ws?.close(1000);
  S = null;
  stopTitleFlash();
  if (!skipServer) {
    try {
      await api('POST', '/api/logout', {});
    } catch { /* session may already be gone */ }
  }
  for (const w of [...windows]) w.close();
  showSignOn(notice);
}

async function loadBuddies() {
  const data = await api('GET', '/api/buddies');
  const fresh = new Map();
  for (const b of data.buddies) {
    const norm = C.normalizeScreenName(b.screenName);
    const prev = S.buddies.get(norm);
    const buddy = { ...b, norm, keyStatus: 'ok', fresh: prev?.fresh ?? false };
    await checkPin(buddy);
    fresh.set(norm, buddy);
  }
  S.buddies = fresh;
  S.incoming = data.incoming;
  S.outgoing = data.outgoing;
  S.blocked = data.blocked;
  renderBuddyList();
  for (const [norm, im] of S.ims) im.update(S.buddies.get(norm));
}

// ---- WebSocket ---------------------------------------------------------------

function connect() {
  const state = S;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;
  setConn('Connecting…');

  ws.addEventListener('open', () => {
    state.wsRetry = 0;
    setConn('');
    if (state.away.on) wsSend({ t: 'status', away: true, awayMessage: state.away.message });
    if (state.connectedBefore) {
      loadBuddies().catch(() => {});
      loadRooms().catch(() => {});
    }
    state.connectedBefore = true;
  });
  ws.addEventListener('message', (e) => {
    if (S !== state) return;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    onServerMessage(msg).catch((err) => console.error(err));
  });
  ws.addEventListener('close', async (e) => {
    if (S !== state || state.signingOff || state.ws !== ws) return;
    if (e.code === 4001) return signOff('You were signed off (signed on elsewhere, password changed, or account removed).', { skipServer: true });
    setConn('Connection lost. Reconnecting…');
    try {
      await api('GET', '/api/me');
    } catch (err) {
      if (err.status === 401) return signOff('Your session expired. Please sign on again.', { skipServer: true });
    }
    const delay = Math.min(30_000, 1000 * 2 ** state.wsRetry++) * (0.75 + Math.random() / 2);
    state.wsTimer = setTimeout(() => { if (S === state) connect(); }, delay);
  });
}

function wsSend(msg) {
  if (S?.ws?.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

async function onServerMessage(msg) {
  switch (msg.t) {
    case 'im':
      return receiveIm(msg);
    case 'sent': {
      if (msg.room) {
        S.roomPending.delete(msg.id);
        return;
      }
      const norm = S.pending.get(msg.id);
      S.pending.delete(msg.id);
      if (msg.queued && norm) {
        const b = S.buddies.get(norm);
        S.ims.get(norm)?.sys(`${b?.screenName ?? 'Your buddy'} is offline. The encrypted message will be delivered when they sign on.`);
      }
      return;
    }
    case 'error': {
      if (msg.room) return roomSendFailed(msg);
      const norm = S.pending.get(msg.id);
      S.pending.delete(msg.id);
      if (norm) S.ims.get(norm)?.sys(`Not delivered: ${msg.error}`, 'warn');
      return;
    }
    case 'presence': {
      const b = S.buddies.get(C.normalizeScreenName(msg.screenName));
      if (!b) return;
      const wasOnline = b.online;
      Object.assign(b, { online: msg.online, away: msg.away, awayMessage: msg.awayMessage });
      if (!wasOnline && b.online) {
        sounds.doorOpen();
        b.fresh = true;
        setTimeout(() => { b.fresh = false; refreshBuddy(b); }, 15_000);
      } else if (wasOnline && !b.online) {
        sounds.doorClose();
        b.fresh = false;
      }
      return refreshBuddy(b);
    }
    case 'room':
    case 'roomPresence':
    case 'roomJoined':
    case 'roomLeft':
    case 'roomInvited':
    case 'roomInvite':
    case 'roomRekey':
    case 'roomKey':
    case 'roomTopic':
    case 'roomClosed':
    case 'roomRemoved':
      return onRoomEvent(msg);
    case 'roles': {
      // The owner changed our admin status; takes effect immediately.
      const was = S.me.isAdmin;
      Object.assign(S.me, { isAdmin: msg.isAdmin, isOwner: msg.isOwner });
      if (was !== msg.isAdmin) {
        dialogs.get('admin')?.close();
        alertBox('Admin', msg.isAdmin
          ? "You're now an admin. You can make campaign codes (Setup → Admin Tools) and run public chat rooms."
          : 'You are no longer an admin.');
      }
      return undefined;
    }
    case 'typing': {
      const im = S.ims.get(C.normalizeScreenName(msg.from));
      im?.typing(msg.on);
      return;
    }
    case 'buddyRequest':
      if (!S.incoming.includes(msg.screenName)) S.incoming.push(msg.screenName);
      sounds.imIn();
      return renderBuddyList();
    case 'buddyAdded': {
      const b = { ...msg.buddy, norm: C.normalizeScreenName(msg.buddy.screenName), keyStatus: 'ok' };
      await checkPin(b);
      S.buddies.set(b.norm, b);
      S.incoming = S.incoming.filter((n) => C.normalizeScreenName(n) !== b.norm);
      S.outgoing = S.outgoing.filter((n) => C.normalizeScreenName(n) !== b.norm);
      if (b.online) sounds.doorOpen();
      return refreshBuddy(b);
    }
    case 'buddyRemoved': {
      const norm = C.normalizeScreenName(msg.screenName);
      S.buddies.delete(norm);
      S.incoming = S.incoming.filter((n) => C.normalizeScreenName(n) !== norm);
      S.outgoing = S.outgoing.filter((n) => C.normalizeScreenName(n) !== norm);
      S.ims.get(norm)?.update(undefined);
      return renderBuddyList();
    }
    default:
  }
}

// ---- Messages -----------------------------------------------------------

async function receiveIm(msg) {
  if (msg.oid) {
    S.delivered.push(msg.oid);
    clearTimeout(S.deliveredTimer);
    S.deliveredTimer = setTimeout(() => {
      if (wsSend({ t: 'delivered', oids: S.delivered })) S.delivered = [];
    }, 300);
  }
  if (S.seen.has(msg.id)) return;
  S.seen.add(msg.id);
  const b = S.buddies.get(C.normalizeScreenName(msg.from));
  if (!b) return;
  const im = openIm(b, { focus: false });
  if (b.keyStatus === 'changed') {
    im.sys(`A message from ${b.screenName} was hidden because their encryption key changed. Verify it in Buddy Info first.`, 'warn');
    return;
  }
  let payload;
  try {
    payload = await C.decryptMessage(await convKey(b), { from: b.norm, to: S.me.norm, id: msg.id }, msg.env);
  } catch {
    im.sys(`A message from ${b.screenName} could not be decrypted and was discarded.`, 'warn');
    return;
  }
  if (typeof payload?.text !== 'string' || typeof payload.ts !== 'number') return;
  if (Date.now() - payload.ts > OFFLINE_MAX_AGE) return; // stale or replayed
  const text = payload.text.slice(0, MAX_TEXT);
  im.add(b.screenName, 'them', text, payload.ts, { auto: payload.auto === true, offline: msg.offline });
  sounds.imIn();
  if (!im.win.active) {
    S.unread.set(b.norm, (S.unread.get(b.norm) ?? 0) + 1);
    im.updateTask();
    renderBuddyList();
    im.win.flash();
    if (isSmall() && !document.hidden) {
      toast(`${b.screenName}: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`, () => openIm(b));
    }
  }
  titleFlash(b.screenName);
  if (S.away.on && !payload.auto && !S.autoReplied.has(b.norm)) {
    S.autoReplied.add(b.norm);
    sendIm(b, S.away.message, { auto: true });
  }
}

async function sendIm(b, text, { auto = false } = {}) {
  const im = openIm(b, { focus: false });
  if (b.keyStatus === 'changed') {
    im.sys(`Not sent: ${b.screenName}'s encryption key changed. Verify it in Buddy Info first.`, 'warn');
    return false;
  }
  const id = C.randomId();
  const ts = Date.now();
  const env = await C.encryptMessage(await convKey(b), { from: S.me.norm, to: b.norm, id }, { text, ts, auto });
  S.pending.set(id, b.norm);
  if (!wsSend({ t: 'im', to: b.screenName, id, env })) {
    S.pending.delete(id);
    im.sys('Not connected. Your message was not sent.', 'warn');
    return false;
  }
  im.add(S.me.screenName, 'me', text, ts, { auto });
  if (!auto) sounds.imOut();
  return true;
}

// ---- Title flashing for unseen messages --------------------------------------

let flashTimer = null;
function titleFlash(from) {
  if (!document.hidden) return;
  stopTitleFlash();
  let on = false;
  flashTimer = setInterval(() => {
    on = !on;
    document.title = on ? `*** IM from ${from} ***` : `${S?.me.screenName ?? ''} - ${APP_NAME}`;
  }, 1000);
}
function stopTitleFlash() {
  clearInterval(flashTimer);
  flashTimer = null;
  document.title = S ? `${S.me.screenName} - ${APP_NAME}` : APP_NAME;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !S) return;
  stopTitleFlash();
  // Phones often kill the connection while the app is in the background.
  if (!S.ws || S.ws.readyState >= WebSocket.CLOSING) {
    clearTimeout(S.wsTimer);
    S.wsRetry = 0;
    connect();
  }
  // Mark whatever conversation is on screen as read.
  topWindow()?.focus();
});

// ===========================================================================
// Buddy List window

let blTree;
let blHeadName;
let blAway;
let blConn;

function setConn(text) {
  if (blConn) blConn.textContent = text;
}

function buildBuddyList() {
  const win = makeWindow({
    title: `${S.me.screenName}'s Buddy List`, taskLabel: 'Buddies', cls: 'buddylist', closable: false,
    x: Math.max(0, desktop.clientWidth - 280), y: 16,
  });
  S.buddyWin = win;
  blHeadName = h('div', { class: 'me', text: S.me.screenName });
  blAway = h('div', { class: 'away-banner', hidden: true });
  blTree = h('div', { class: 'bl-tree sunken', role: 'tree', tabindex: '0' });
  blConn = h('div', { class: 'conn muted' });
  const btn = (text, onclick, title) => h('button', { type: 'button', text, onclick, title });
  win.body.append(
    h('div', { class: 'bl-head sunken' }, h('img', { src: '/img/buddy.svg', alt: '' }),
      h('div', {}, blHeadName, h('div', { class: 'small muted', text: '🔒 Encrypted' }))),
    blAway,
    blTree,
    blConn,
    h('div', { class: 'bl-buttons' },
      btn('IM', () => { const b = selectedBuddy(); if (b) openIm(b); else addBuddyDialog(); }, 'Send an Instant Message'),
      btn('Add', addBuddyDialog, 'Add a buddy'),
      btn('Info', () => { const b = selectedBuddy(); if (b) buddyInfo(b); }, 'Buddy info & encryption'),
      btn('Chat', roomsDialog, 'Chat rooms'),
      btn('Away', awayDialog, 'Set an away message'),
      btn('Invite', inviteDialog, 'Invite a friend'),
      btn('Setup', setupDialog, 'Preferences & account'),
      btn('Sign Off', () => signOff(), 'Sign off')),
  );
  blTree.addEventListener('keydown', (e) => {
    const items = [...blTree.querySelectorAll('.bl-item[data-norm]')];
    const i = items.findIndex((el) => el.dataset.norm === S.selected);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) select(next.dataset.norm);
    } else if (e.key === 'Enter') {
      const b = selectedBuddy();
      if (b) openIm(b);
    }
  });
}

function selectedBuddy() {
  return S.selected ? S.buddies.get(S.selected) : null;
}

function select(norm) {
  S.selected = norm;
  for (const el of blTree.querySelectorAll('.bl-item[data-norm]')) el.classList.toggle('sel', el.dataset.norm === norm);
}

function refreshBuddy(b) {
  renderBuddyList();
  S.ims.get(b.norm)?.update(b);
}

function renderBuddyList() {
  if (!S || !blTree) return;
  const scroll = blTree.scrollTop;
  blTree.replaceChildren();

  if (S.away.on) {
    blAway.hidden = false;
    blAway.replaceChildren(h('span', { text: `Away: ${S.away.message}` }),
      h('button', { type: 'button', text: "I'm Back", onclick: () => setAway(false) }));
  } else {
    blAway.hidden = true;
  }

  const groupEl = (key, label, count) => {
    const collapsed = S.collapsed.has(key);
    const el = h('div', { class: `bl-group${collapsed ? ' collapsed' : ''}`, role: 'treeitem', 'aria-expanded': String(!collapsed), text: `${label} (${count})` });
    el.addEventListener('click', () => {
      if (S.collapsed.has(key)) S.collapsed.delete(key);
      else S.collapsed.add(key);
      prefs.set('collapsed', [...S.collapsed]);
      renderBuddyList();
    });
    blTree.append(el);
    return !collapsed;
  };

  if (S.incoming.length) {
    if (groupEl('#requests', 'Buddy Requests', S.incoming.length)) {
      for (const name of S.incoming) {
        blTree.append(h('div', { class: 'bl-item' },
          h('span', { class: 'name grow', text: name }),
          h('button', { type: 'button', text: '✓', title: 'Accept', onclick: () => respond(name, true) }),
          h('button', { type: 'button', text: '✗', title: 'Decline', onclick: () => respond(name, false) })));
      }
    }
  }

  if (S.roomInvites.length && groupEl('#room-invites', 'Room Invites', S.roomInvites.length)) {
    for (const inv of S.roomInvites) {
      blTree.append(h('div', { class: 'bl-item', title: `From ${inv.from}` },
        h('span', { class: 'name grow', text: `🔒 ${inv.name}` }),
        h('button', { type: 'button', text: '✓', title: 'Join', onclick: () => respondRoomInvite(inv, true) }),
        h('button', { type: 'button', text: '✗', title: 'Decline', onclick: () => respondRoomInvite(inv, false) })));
    }
  }

  if (S.rooms.size && groupEl('#rooms', 'Chat Rooms', S.rooms.size)) {
    const rooms = [...S.rooms.values()].sort((a, c) => a.name.localeCompare(c.name));
    for (const room of rooms) {
      const el = h('div', { class: `bl-item bl-room${room.mention ? ' mention' : ''}`, role: 'treeitem' },
        h('span', { class: 'name', text: `${room.kind === 'private' ? '🔒' : '#'} ${room.name}` }),
        h('span', { class: 'tag', text: `(${room.online})` }),
        room.unread ? h('span', { class: 'badge', text: room.mention ? '@' : String(room.unread) }) : null);
      el.addEventListener(isTouch() ? 'click' : 'dblclick', () => openRoom(room.id));
      blTree.append(el);
    }
  }

  const all = [...S.buddies.values()];
  const groups = new Map();
  for (const b of all) {
    if (!b.online) continue;
    if (!groups.has(b.group)) groups.set(b.group, []);
    groups.get(b.group).push(b);
  }
  // Keep empty groups visible too.
  for (const b of all) if (!groups.has(b.group)) groups.set(b.group, []);
  const groupNames = [...groups.keys()].sort((a, c) => (a === 'Buddies' ? -1 : c === 'Buddies' ? 1 : a.localeCompare(c)));

  const buddyItem = (b) => {
    const cls = ['bl-item', b.online ? '' : 'offline', b.away ? 'away' : '', b.fresh ? 'fresh' : '', S.selected === b.norm ? 'sel' : ''].join(' ');
    const el = h('div', { class: cls, role: 'treeitem', 'data-norm': b.norm, title: b.away ? `Away: ${b.awayMessage}` : '' },
      h('span', { class: 'name', text: b.screenName }),
      b.away ? h('span', { class: 'tag', text: '(away)' }) : null,
      b.keyStatus === 'changed' ? h('span', { class: 'warn', text: '⚠', title: 'Encryption key changed!' }) : null,
      b.keyStatus === 'verified' ? h('span', { class: 'tag', text: '✔', title: 'Verified' }) : null,
      S.unread.get(b.norm) ? h('span', { class: 'badge', text: String(S.unread.get(b.norm)), 'aria-label': 'unread messages' }) : null);
    el.addEventListener('click', () => {
      select(b.norm);
      if (isTouch()) openIm(b);
    });
    el.addEventListener('dblclick', () => openIm(b));
    return el;
  };

  for (const g of groupNames) {
    const members = all.filter((b) => b.group === g);
    const online = members.filter((b) => b.online);
    if (groupEl(`g:${g}`, g, `${online.length}/${members.length}`)) {
      for (const b of online) blTree.append(buddyItem(b));
    }
  }
  const offline = all.filter((b) => !b.online);
  if (groupEl('#offline', 'Offline', `${offline.length}/${all.length}`)) {
    for (const b of offline) blTree.append(buddyItem(b));
  }
  if (S.outgoing.length && groupEl('#outgoing', 'Awaiting Reply', S.outgoing.length)) {
    for (const name of S.outgoing) blTree.append(h('div', { class: 'bl-item offline', text: name }));
  }
  if (!all.length && !S.incoming.length && !S.outgoing.length && !S.rooms.size) {
    blTree.append(h('p', { class: 'hint', text: 'Your Buddy List is empty. Tap "Add" to add a friend by screen name, "Chat" to find a chat room, or "Invite" to get a friend signed up.' }));
  }
  blTree.scrollTop = scroll;
}

async function respond(name, accept) {
  try {
    await api('POST', '/api/buddies/respond', { screenName: name, accept });
    S.incoming = S.incoming.filter((n) => n !== name);
    renderBuddyList();
  } catch (err) {
    alertBox('Buddy Request', err.message);
  }
}

// ===========================================================================
// IM windows

function openIm(b, { focus = true } = {}) {
  let im = S.ims.get(b.norm);
  if (!im) im = createIm(b, { background: !focus });
  if (focus) {
    im.win.focus();
    if (!isTouch()) im.input.focus();
  } else if (!im.win.visible && !isSmall()) {
    im.win.el.classList.remove('hidden');
  }
  return im;
}

function createIm(buddy, { background = false } = {}) {
  let b = buddy;
  const norm = b.norm;
  let im;
  const win = makeWindow({
    title: `${b.screenName} - Instant Message`, taskLabel: b.screenName, cls: 'im', back: 'minimize', background,
    onClose: () => {
      S?.ims.delete(norm);
      S?.unread.delete(norm);
      renderBuddyList();
    },
    onFocus: () => {
      if (im && S?.unread.delete(norm)) {
        im.updateTask();
        renderBuddyList();
      }
    },
  });
  const transcript = h('div', { class: `transcript sunken${prefs.get('timestamps', true) ? '' : ' hide-ts'}`, role: 'log', 'aria-live': 'polite' });
  const status = h('div', { class: 'statusbar' });
  const lock = h('button', { type: 'button', class: 'lock' });
  const input = h('textarea', { maxlength: String(MAX_TEXT), 'aria-label': 'Message', placeholder: 'Type a message…', enterkeyhint: 'send', rows: '2' });
  const send = h('button', { type: 'button', text: 'Send' });
  let typingTimer = null;
  let typingSentAt = 0;
  let stopTypingTimer = null;

  lock.addEventListener('click', () => { if (b) buddyInfo(b); });
  win.body.append(
    h('div', { class: 'im-bar' }, lock, h('span', { class: 'grow' }),
      h('button', { type: 'button', text: 'Info', onclick: () => { if (b) buddyInfo(b); } })),
    transcript, status,
    h('div', { class: 'compose' }, input, send));

  let stick = true;
  const scrollDown = () => { transcript.scrollTop = transcript.scrollHeight; };
  transcript.addEventListener('scroll', () => {
    stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  });
  new ResizeObserver(() => { if (stick) scrollDown(); }).observe(transcript);
  const doSend = async () => {
    const text = input.value.replace(/\s+$/, '');
    if (!text.trim() || !b) return;
    if (text.length > MAX_TEXT) return;
    input.value = '';
    input.style.height = '';
    clearTimeout(stopTypingTimer);
    typingSentAt = 0;
    wsSend({ t: 'typing', to: b.screenName, on: false });
    if (!(await sendIm(b, text))) input.value = text;
    input.focus();
  };
  send.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  });
  input.addEventListener('input', () => {
    if (isSmall()) {
      // Grow with the text on phones, up to the CSS max-height.
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight + 4}px`;
    }
    if (!b || !b.online) return;
    const now = Date.now();
    if (now - typingSentAt > 3000) {
      typingSentAt = now;
      wsSend({ t: 'typing', to: b.screenName, on: true });
    }
    clearTimeout(stopTypingTimer);
    stopTypingTimer = setTimeout(() => {
      typingSentAt = 0;
      if (b) wsSend({ t: 'typing', to: b.screenName, on: false });
    }, 4000);
  });

  let typingOn = false;
  const renderStatus = () => {
    if (!b) status.textContent = 'This person is no longer on your Buddy List.';
    else if (typingOn) status.textContent = `${b.screenName} is typing…`;
    else if (!b.online) status.textContent = `${b.screenName} is offline. Messages will be delivered when they sign on.`;
    else if (b.away) status.textContent = `${b.screenName} is away: ${b.awayMessage}`;
    else status.textContent = '';
  };

  im = {
    win, input,
    updateTask() {
      const n = S?.unread.get(norm) ?? 0;
      win.setTaskLabel(b ? `${b.screenName}${n ? ` (${n})` : ''}` : win.taskBtn?.textContent);
    },
    add(who, side, text, ts, { auto = false, offline = false } = {}) {
      const line = h('div', { class: `line${auto ? ' auto' : ''}` },
        h('span', { class: `who ${side}`, text: auto ? `Auto response from ${who}` : who }),
        h('span', { class: 'ts', text: ` (${timeFmt(ts)}${offline ? ', while you were away' : ''})` }),
        ': ',
        h('span', { class: 'text', text }));
      transcript.append(line);
      if (stick || side === 'me') scrollDown();
      if (side === 'them') {
        typingOn = false;
        renderStatus();
      }
    },
    sys(text, kind = '') {
      transcript.append(h('div', { class: `line sys ${kind}`, text }));
      scrollDown();
    },
    typing(on) {
      typingOn = on;
      renderStatus();
      clearTimeout(typingTimer);
      if (on) typingTimer = setTimeout(() => { typingOn = false; renderStatus(); }, 6000);
    },
    update(next) {
      b = next;
      if (b) win.setTitle(`${b.screenName} - Instant Message`);
      im.updateTask();
      const ks = b?.keyStatus;
      lock.className = `lock ${ks === 'verified' ? 'verified' : ks === 'changed' ? 'changed' : ''}`;
      lock.textContent = !b ? '🔒 Encrypted'
        : ks === 'changed' ? '⚠ Key changed! Verify'
          : ks === 'verified' ? '🔒 Encrypted · Verified' : '🔒 Encrypted · Not verified';
      lock.title = 'End-to-end encrypted. Click to compare safety numbers.';
      send.disabled = !b || ks === 'changed';
      input.disabled = !b;
      renderStatus();
    },
  };
  im.update(b);
  im.sys('Messages in this window are end-to-end encrypted and are not saved anywhere. Closing the window erases the conversation.');
  S.ims.set(norm, im);
  return im;
}

// ===========================================================================
// Chat rooms
//
// Public rooms: anyone can join from the directory; messages are protected by
// HTTPS only and relayed live (never stored). Private rooms: invite-only and
// end-to-end encrypted with a shared room key (see crypto.js). Neither keeps
// history; what you see lives in this tab's memory until you close the window.

const MAX_ROOM_TEXT = 2000;
const MAX_ROOM_LOG = 300;

async function loadRooms() {
  const data = await api('GET', '/api/rooms');
  const next = new Map();
  for (const r of data.mine) {
    const prev = S.rooms.get(r.id);
    next.set(r.id, { ...r, unread: prev?.unread ?? 0, mention: prev?.mention ?? false });
  }
  for (const id of S.rooms.keys()) if (!next.has(id)) forgetRoom(id);
  S.rooms = next;
  S.roomInvites = data.invites.map((r) => ({ id: r.id, name: r.name, from: S.roomInvites.find((x) => x.id === r.id)?.from ?? 'a buddy' }));
  renderBuddyList();
  for (const [id, w] of S.roomWins) w.update(S.rooms.get(id));
  return data;
}

let roomsRefreshTimer = null;
function refreshRoomsSoon() {
  clearTimeout(roomsRefreshTimer);
  roomsRefreshTimer = setTimeout(() => { if (S) loadRooms().catch(() => {}); }, 400);
}

function forgetRoom(id) {
  S.rooms.delete(id);
  S.roomKeys.delete(id);
  S.roomLogs.delete(id);
  S.roomWins.get(id)?.win.close();
}

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentionsMe(text) {
  const names = [S.me.screenName, S.me.norm].map(escapeRe).join('|');
  return new RegExp(`(^|[^\\p{L}\\p{N}])@?(${names})(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

function isBlockedName(name) {
  const n = C.normalizeScreenName(name);
  return S.blocked.some((x) => C.normalizeScreenName(x) === n);
}

// ---- Room keys (private rooms) ---------------------------------------------

// A buddy's key as pinned on this device; refuse to use a different one.
function checkAgainstPins(screenName, publicKey) {
  const b = S.buddies.get(C.normalizeScreenName(screenName));
  if (b && (b.keyStatus === 'changed' || C.canonicalPublicKey(b.publicKey) !== C.canonicalPublicKey(publicKey))) {
    throw new Error(`${screenName}'s encryption key doesn't match the one you have for them. Check Buddy Info before continuing.`);
  }
}

async function wrapRoomKeyFor(roomId, epoch, raw, screenName, publicKey) {
  checkAgainstPins(screenName, publicKey);
  const pair = await C.deriveConversationKey(S.me.privateKey, publicKey);
  return C.wrapRoomKey(pair, { roomId, epoch, from: S.me.norm, to: C.normalizeScreenName(screenName) }, raw);
}

// Make sure we hold the current key for a private room. With create: true it
// also generates a new key when the room needs one (just created, or someone
// left). Concurrent calls for the same room share one request. Returns details.
const roomKeyLoads = new Map();
function ensureRoomKey(roomId, { create = true } = {}) {
  const k = `${roomId}:${create}`;
  if (!roomKeyLoads.has(k)) {
    roomKeyLoads.set(k, loadRoomKey(roomId, create).finally(() => roomKeyLoads.delete(k)));
  }
  return roomKeyLoads.get(k);
}

async function loadRoomKey(roomId, create, attempt = 0) {
  const d = await api('POST', '/api/rooms/get', { room: roomId });
  if (d.room.kind !== 'private' || d.room.status !== 'member') return d;
  const cached = S.roomKeys.get(roomId);
  if (cached?.epoch === d.room.epoch) return d;
  if (d.key) {
    checkAgainstPins(d.key.from, d.key.fromPublicKey);
    const pair = await C.deriveConversationKey(S.me.privateKey, d.key.fromPublicKey);
    const raw = await C.unwrapRoomKey(pair, { roomId, epoch: d.room.epoch, from: d.key.from, to: S.me.norm }, d.key.envelope);
    S.roomKeys.set(roomId, { epoch: d.room.epoch, raw, key: await C.importRoomKey(raw) });
    return d;
  }
  if (!create) return d;
  if (d.hasKey || attempt > 3) throw new Error('Could not get the key for this room.');
  // Nobody has made a key for this epoch yet: make one and share it with everyone in the room.
  const raw = C.newRoomKey();
  const keys = await Promise.all(d.members.map(async (m) => ({
    screenName: m.screenName,
    envelope: await wrapRoomKeyFor(roomId, d.room.epoch, raw, m.screenName, m.publicKey),
  })));
  try {
    await api('POST', '/api/rooms/rekey', { room: roomId, epoch: d.room.epoch, keys });
    S.roomKeys.set(roomId, { epoch: d.room.epoch, raw, key: await C.importRoomKey(raw) });
    return d;
  } catch (err) {
    if (err.status !== 409) throw err;
    return loadRoomKey(roomId, create, attempt + 1); // someone else beat us to it, or membership changed
  }
}

// ---- Sending & receiving -----------------------------------------------------

async function sendRoomMessage(roomId, text) {
  const room = S.rooms.get(roomId);
  if (!room) return false;
  const id = C.randomId();
  let msg;
  if (room.kind === 'private') {
    await ensureRoomKey(roomId);
    const k = S.roomKeys.get(roomId);
    const env = await C.encryptRoomMessage(k.key, { roomId, epoch: k.epoch, from: S.me.norm, id }, { text, ts: Date.now() });
    msg = { t: 'room', room: roomId, id, epoch: k.epoch, env };
  } else {
    msg = { t: 'room', room: roomId, id, text };
  }
  if (!wsSend(msg)) {
    roomLog(roomId, { sys: 'Not connected. Your message was not sent.', cls: 'warn' });
    return false;
  }
  const retried = S.roomPending.get(id)?.retried ?? false;
  S.roomPending.set(id, { room: roomId, text, retried });
  roomLog(roomId, { from: S.me.screenName, side: 'me', text, ts: Date.now() });
  sounds.imOut();
  return true;
}

async function roomSendFailed(msg) {
  const p = S.roomPending.get(msg.id);
  S.roomPending.delete(msg.id);
  if (msg.rekey && p && !p.retried) {
    // The key changed between typing and sending: fetch the new key and resend once.
    S.roomKeys.delete(msg.room);
    try {
      await ensureRoomKey(msg.room);
      const id = C.randomId();
      const k = S.roomKeys.get(msg.room);
      const env = await C.encryptRoomMessage(k.key, { roomId: msg.room, epoch: k.epoch, from: S.me.norm, id }, { text: p.text, ts: Date.now() });
      S.roomPending.set(id, { ...p, retried: true });
      wsSend({ t: 'room', room: msg.room, id, epoch: k.epoch, env });
      return;
    } catch { /* fall through to the error line */ }
  }
  roomLog(msg.room, { sys: `Not delivered: ${msg.error}`, cls: 'warn' });
}

async function receiveRoomMessage(m) {
  const room = S.rooms.get(m.room);
  if (!room || isBlockedName(m.from)) return;
  let text;
  let ts = m.ts ?? Date.now();
  if (m.env) {
    let k = S.roomKeys.get(m.room);
    if (k?.epoch !== m.epoch) {
      try {
        await ensureRoomKey(m.room, { create: false });
      } catch { /* reported below */ }
      k = S.roomKeys.get(m.room);
    }
    try {
      const p = await C.decryptRoomMessage(k.key, { roomId: m.room, epoch: m.epoch, from: m.from, id: m.id }, m.env);
      if (typeof p.text !== 'string') return;
      text = p.text.slice(0, MAX_ROOM_TEXT);
      ts = typeof p.ts === 'number' ? p.ts : ts;
    } catch {
      roomLog(m.room, { sys: `A message from ${m.from} could not be decrypted.`, cls: 'warn' });
      return;
    }
  } else {
    text = String(m.text).slice(0, MAX_ROOM_TEXT);
  }
  const mention = mentionsMe(text);
  roomLog(m.room, { from: m.from, side: 'them', text, ts, mention });
  const w = S.roomWins.get(m.room);
  if (!w?.win.active) {
    room.unread = (room.unread ?? 0) + 1;
    if (mention) {
      room.mention = true;
      sounds.imIn();
      titleFlash(`${m.from} in ${room.name}`);
      if (isSmall() && !document.hidden) toast(`${m.from} in ${room.name}: ${text.slice(0, 80)}`, () => openRoom(room.id));
    }
    w?.updateTask();
    renderBuddyList();
  }
}

// Append a line to a room's in-memory log and its window, if open.
function roomLog(roomId, line) {
  let log = S.roomLogs.get(roomId);
  if (!log) S.roomLogs.set(roomId, (log = []));
  log.push(line);
  if (log.length > MAX_ROOM_LOG) log.splice(0, log.length - MAX_ROOM_LOG);
  S.roomWins.get(roomId)?.append(line);
}

async function onRoomEvent(msg) {
  const id = msg.room?.id ?? msg.room;
  const room = S.rooms.get(id);
  const w = S.roomWins.get(id);
  switch (msg.t) {
    case 'room':
      return receiveRoomMessage(msg);
    case 'roomPresence':
      if (w) {
        roomLog(id, { sys: `${msg.screenName} has ${msg.online ? 'entered' : 'left'} the room.` });
        if (msg.online) sounds.doorOpen();
        else sounds.doorClose();
        w.reload();
      }
      return refreshRoomsSoon();
    case 'roomJoined':
      if (w) {
        roomLog(id, { sys: `${msg.screenName} joined the room.` });
        sounds.doorOpen();
        w.reload();
      }
      return refreshRoomsSoon();
    case 'roomLeft':
      if (room && msg.newOwner && C.normalizeScreenName(msg.newOwner) === S.me.norm) room.role = 'owner';
      if (w) {
        roomLog(id, { sys: `${msg.screenName} left the room.` });
        if (msg.newOwner) roomLog(id, { sys: `${msg.newOwner} is now the room owner.` });
        sounds.doorClose();
        w.reload();
      }
      return refreshRoomsSoon();
    case 'roomInvited':
      if (w) {
        roomLog(id, { sys: `${msg.by} invited ${msg.screenName}.` });
        w.reload();
      }
      return undefined;
    case 'roomInvite':
      if (!S.roomInvites.some((x) => x.id === id)) S.roomInvites.push({ id, name: msg.room.name, from: msg.from });
      sounds.imIn();
      if (isSmall()) toast(`${msg.from} invited you to the private room "${msg.room.name}"`, () => S.buddyWin.focus());
      return renderBuddyList();
    case 'roomRekey':
      // Someone left: the old key is retired. The owner makes a new one right away;
      // if the owner isn't around, whoever sends the next message does.
      S.roomKeys.delete(id);
      if (room?.role === 'owner') ensureRoomKey(id).catch(() => {});
      return undefined;
    case 'roomKey':
      if (S.roomKeys.get(id)?.epoch !== msg.epoch) {
        S.roomKeys.delete(id);
        if (w) ensureRoomKey(id, { create: false }).catch(() => {});
      }
      return undefined;
    case 'roomTopic':
      if (room) room.topic = msg.topic;
      roomLog(id, { sys: `${msg.by} changed the topic to: ${msg.topic || '(none)'}` });
      w?.update(room);
      return undefined;
    case 'roomClosed':
    case 'roomRemoved':
      S.roomInvites = S.roomInvites.filter((x) => x.id !== id);
      if (room || w) {
        forgetRoom(id);
        alertBox('Chat Room', msg.t === 'roomClosed' ? `"${msg.name}" was closed.` : `You were removed from "${msg.name}".`);
      }
      return renderBuddyList();
    default:
      return undefined;
  }
}

// ---- Joining, leaving, inviting ------------------------------------------------

async function respondRoomInvite(inv, accept) {
  try {
    await api('POST', '/api/rooms/respond', { room: inv.id, accept });
    S.roomInvites = S.roomInvites.filter((x) => x.id !== inv.id);
    await loadRooms();
    if (accept) openRoom(inv.id);
  } catch (err) {
    alertBox('Room Invite', err.message);
    loadRooms().catch(() => {});
  }
}

async function joinPublicRoom(id) {
  await api('POST', '/api/rooms/join', { room: id });
  await loadRooms();
  openRoom(id);
}

async function leaveRoom(id) {
  const room = S.rooms.get(id);
  if (!room) return;
  const extra = room.kind === 'private' && room.role === 'owner' ? ' Someone else in the room will become the owner.' : '';
  if (!confirm(`Leave "${room.name}"?${extra}`)) return;
  try {
    await api('POST', '/api/rooms/leave', { room: id });
    forgetRoom(id);
    renderBuddyList();
  } catch (err) {
    alertBox('Leave Room', err.message);
  }
}

function inviteToRoomDialog(roomId) {
  const room = S.rooms.get(roomId);
  if (!room) return;
  dialog(`room-invite:${roomId}`, { title: `Invite to ${room.name}` }, async (win) => {
    const msg = h('p', { class: 'small', role: 'status' });
    const list = h('div', { class: 'list sunken' });
    const go = h('button', { type: 'button', text: 'Invite' });
    win.body.append(
      h('p', { class: 'hint', text: 'Pick buddies to invite. Each one gets their own encrypted copy of the room key.' }),
      list, msg,
      h('div', { class: 'row end' }, go, h('button', { type: 'button', text: 'Close', onclick: () => win.close() })));
    let details;
    try {
      details = await ensureRoomKey(roomId);
    } catch (err) {
      msg.className = 'small error';
      msg.textContent = err.message;
      return;
    }
    const inRoom = new Set(details.members.map((m) => C.normalizeScreenName(m.screenName)));
    const candidates = [...S.buddies.values()].filter((b) => !inRoom.has(b.norm)).sort((a, c) => a.norm.localeCompare(c.norm));
    if (!candidates.length) list.append(h('div', { class: 'muted small', text: 'All your buddies are already here.' }));
    const boxes = candidates.map((b) => {
      const box = h('input', { type: 'checkbox', value: b.norm });
      list.append(h('label', { class: 'check' }, box, b.screenName, b.online ? '' : h('span', { class: 'muted small', text: ' (offline)' })));
      return box;
    });
    go.addEventListener('click', async () => {
      const picked = boxes.filter((x) => x.checked).map((x) => S.buddies.get(x.value));
      if (!picked.length) return;
      go.disabled = true;
      const done = [];
      const failed = [];
      for (const b of picked) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await ensureRoomKey(roomId);
            const k = S.roomKeys.get(roomId);
            const envelope = await wrapRoomKeyFor(roomId, k.epoch, k.raw, b.screenName, b.publicKey);
            await api('POST', '/api/rooms/invite', { room: roomId, screenName: b.screenName, epoch: k.epoch, envelope });
            done.push(b.screenName);
            break;
          } catch (err) {
            if (err.status === 409 && attempt === 0) {
              S.roomKeys.delete(roomId);
              continue;
            }
            failed.push(`${b.screenName}: ${err.message}`);
            break;
          }
        }
      }
      msg.className = failed.length ? 'small error' : 'small ok';
      msg.textContent = [done.length ? `Invited ${done.join(', ')}.` : '', ...failed].filter(Boolean).join(' ');
      go.disabled = false;
      if (!failed.length) setTimeout(() => win.close(), 800);
    });
  });
}

function roomMemberDialog(roomId, member, canModerate) {
  const norm = C.normalizeScreenName(member.screenName);
  if (norm === S.me.norm) return;
  const buddy = S.buddies.get(norm);
  dialog(`room-member:${roomId}:${norm}`, { title: member.screenName }, (win) => {
    const room = S.rooms.get(roomId);
    win.body.append(
      h('p', {}, h('strong', { text: member.screenName }), member.role === 'owner' ? ' — room owner' : '', member.status === 'invited' ? ' — invited' : ''),
      h('div', { class: 'row wrap end' },
        buddy ? h('button', { type: 'button', text: 'Send IM', onclick: () => { win.close(); openIm(buddy); } })
          : h('button', {
            type: 'button', text: 'Add Buddy',
            onclick: async () => {
              try {
                const r = await api('POST', '/api/buddies/request', { screenName: member.screenName });
                if (r.status !== 'accepted' && r.screenName && !S.outgoing.includes(r.screenName)) S.outgoing.push(r.screenName);
                renderBuddyList();
                win.close();
              } catch (err) { alertBox('Add Buddy', err.message); }
            },
          }),
        canModerate ? h('button', {
          type: 'button', text: 'Remove from room',
          onclick: async () => {
            if (!confirm(`Remove ${member.screenName} from "${room?.name}"? They won't be able to come back.`)) return;
            try {
              await api('POST', '/api/rooms/kick', { room: roomId, screenName: member.screenName });
              win.close();
            } catch (err) { alertBox('Remove', err.message); }
          },
        }) : null,
        h('button', { type: 'button', text: 'Close', onclick: () => win.close() })));
  });
}

function roomOptionsDialog(roomId) {
  const room = S.rooms.get(roomId);
  if (!room) return;
  const canModerate = room.kind === 'public' ? S.me.isAdmin : room.role === 'owner';
  dialog(`room-options:${roomId}`, { title: `${room.name} Options` }, (win) => {
    const topic = h('input', { type: 'text', maxlength: '120', value: room.topic || '' });
    win.body.append(
      h('p', { class: 'hint', text: room.kind === 'private'
        ? '🔒 Private room: invite-only and end-to-end encrypted. Nothing is saved; you only see what’s said while you’re here.'
        : '# Public room: anyone on Mem Messenger can join. Messages are protected in transit but are not end-to-end encrypted. Nothing is saved.' }),
      canModerate ? h('label', { class: 'field' }, 'Topic', topic) : (room.topic ? h('p', {}, 'Topic: ', room.topic) : null),
      h('div', { class: 'row wrap end' },
        canModerate ? h('button', {
          type: 'button', text: 'Save Topic',
          onclick: async () => {
            try {
              await api('POST', '/api/rooms/topic', { room: roomId, topic: topic.value });
              win.close();
            } catch (err) { alertBox('Topic', err.message); }
          },
        }) : null,
        room.kind === 'private' ? h('button', { type: 'button', text: 'Invite Buddies', onclick: () => { win.close(); inviteToRoomDialog(roomId); } }) : null,
        h('button', { type: 'button', text: 'Leave Room', onclick: () => { win.close(); leaveRoom(roomId); } }),
        canModerate ? h('button', {
          type: 'button', text: 'Close Room',
          onclick: async () => {
            if (!confirm(`Close "${room.name}" for everyone?`)) return;
            try {
              await api('POST', '/api/rooms/close', { room: roomId });
              win.close();
            } catch (err) { alertBox('Close Room', err.message); }
          },
        }) : null));
  });
}

// ---- Room window --------------------------------------------------------------

function openRoom(id) {
  const room = S.rooms.get(id);
  if (!room) return;
  let w = S.roomWins.get(id);
  if (!w) w = createRoomWin(room);
  w.win.focus();
  if (!isTouch()) w.input.focus();
}

function createRoomWin(initial) {
  const id = initial.id;
  let room = initial;
  let w;
  const win = makeWindow({
    title: `${room.name} - Chat Room`, taskLabel: room.name, cls: 'room', back: 'minimize',
    onClose: () => {
      S?.roomWins.delete(id);
      S?.roomLogs.delete(id); // closing the window erases what you saw
    },
    onFocus: () => {
      if (w && room && (room.unread || room.mention)) {
        room.unread = 0;
        room.mention = false;
        w.updateTask();
        renderBuddyList();
      }
    },
  });
  const badge = h('span', { class: 'lock' });
  const topicEl = h('div', { class: 'topic' });
  const transcript = h('div', { class: `transcript sunken${prefs.get('timestamps', true) ? '' : ' hide-ts'}`, role: 'log', 'aria-live': 'polite' });
  const people = h('div', { class: 'people sunken', 'aria-label': 'People in this room' });
  const peopleBtn = h('button', { type: 'button', class: 'people-btn', text: 'People' });
  const input = h('textarea', { maxlength: String(MAX_ROOM_TEXT), 'aria-label': 'Message', placeholder: 'Say something…', enterkeyhint: 'send', rows: '2' });
  const send = h('button', { type: 'button', text: 'Send' });
  const body = h('div', { class: 'room-main' }, transcript, people);

  peopleBtn.addEventListener('click', () => win.el.classList.toggle('show-people'));
  win.body.append(
    h('div', { class: 'im-bar' }, badge, h('span', { class: 'grow' }), peopleBtn,
      h('button', { type: 'button', text: 'Options', onclick: () => roomOptionsDialog(id) })),
    topicEl, body,
    h('div', { class: 'compose' }, input, send));

  let stick = true;
  const scrollDown = () => { transcript.scrollTop = transcript.scrollHeight; };
  transcript.addEventListener('scroll', () => {
    stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  });
  new ResizeObserver(() => { if (stick) scrollDown(); }).observe(transcript);

  const lineEl = (l) => {
    if (l.sys) return h('div', { class: `line sys ${l.cls ?? ''}`, text: l.sys });
    return h('div', { class: `line${l.mention ? ' mention' : ''}` },
      h('span', { class: `who ${l.side}`, text: l.from }),
      h('span', { class: 'ts', text: ` (${timeFmt(l.ts)})` }),
      ': ',
      h('span', { class: 'text', text: l.text }));
  };

  const doSend = async () => {
    const text = input.value.replace(/\s+$/, '');
    if (!text.trim() || text.length > MAX_ROOM_TEXT) return;
    input.value = '';
    input.style.height = '';
    send.disabled = true;
    try {
      if (!(await sendRoomMessage(id, text))) input.value = text;
    } catch (err) {
      input.value = text;
      roomLog(id, { sys: `Not sent: ${err.message}`, cls: 'warn' });
    }
    send.disabled = false;
    if (!isTouch()) input.focus();
  };
  send.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  });
  input.addEventListener('input', () => {
    if (isSmall()) {
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight + 4}px`;
    }
  });

  let loading = null;
  w = {
    win, input,
    append(l) {
      transcript.append(lineEl(l));
      if (stick || l.side === 'me') scrollDown();
    },
    updateTask() {
      const n = room?.unread ?? 0;
      win.setTaskLabel(`${room?.name ?? ''}${room?.mention ? ' (@)' : n ? ` (${n})` : ''}`);
    },
    update(next) {
      if (!next) return;
      room = next;
      win.setTitle(`${room.name} - Chat Room`);
      badge.className = `lock ${room.kind === 'private' ? '' : 'public'}`;
      badge.textContent = room.kind === 'private' ? '🔒 Private · encrypted' : '# Public room';
      badge.title = room.kind === 'private' ? 'End-to-end encrypted' : 'Not end-to-end encrypted. Anyone can join.';
      topicEl.textContent = room.topic ? `Topic: ${room.topic}` : '';
      topicEl.hidden = !room.topic;
      w.updateTask();
    },
    // Refresh the member list (and the room key for private rooms).
    reload() {
      if (loading) return loading;
      loading = (async () => {
        try {
          const d = room.kind === 'private' ? await ensureRoomKey(id, { create: false }) : await api('POST', '/api/rooms/get', { room: id });
          const r = S.rooms.get(id);
          if (r) Object.assign(r, { role: d.room.role, topic: d.room.topic });
          const canModerate = d.room.kind === 'public' ? S.me.isAdmin : d.room.role === 'owner';
          const members = [...d.members].sort((a, c) => (b2n(c.online) - b2n(a.online)) || a.screenName.localeCompare(c.screenName));
          const here = members.filter((m) => m.online && m.status === 'member').length;
          peopleBtn.textContent = `People (${here})`;
          people.replaceChildren(
            h('div', { class: 'people-head', text: d.room.kind === 'public' ? `Here now (${here})` : `Members (${d.room.members})` }),
            ...members.map((m) => {
              const el = h('button', {
                type: 'button',
                class: `person${m.online ? '' : ' offline'}${m.status === 'invited' ? ' invited' : ''}`,
                title: m.status === 'invited' ? 'Invited' : m.online ? 'Online' : 'Offline',
              },
              m.role === 'owner' ? '★ ' : '', m.screenName, m.status === 'invited' ? ' (invited)' : '');
              el.addEventListener('click', () => roomMemberDialog(id, m, canModerate));
              return el;
            }));
          w.update(S.rooms.get(id));
        } catch (err) {
          roomLog(id, { sys: err.message, cls: 'warn' });
        } finally {
          loading = null;
        }
      })();
      return loading;
    },
  };
  const b2n = (x) => (x ? 1 : 0);

  S.roomWins.set(id, w);
  w.update(room);
  roomLog(id, {
    sys: room.kind === 'private'
      ? `You're in "${room.name}". Messages are end-to-end encrypted and never saved. Closing this window erases them.`
      : `You're in "${room.name}". Public rooms aren't end-to-end encrypted, but nothing is saved. Closing this window erases what you see.`,
  });
  for (const l of S.roomLogs.get(id) ?? []) if (!l.sys || !l.sys.startsWith("You're in")) transcript.append(lineEl(l));
  scrollDown();
  w.reload();
  return w;
}

// ---- Directory ----------------------------------------------------------------

function roomsDialog() {
  dialog('rooms', { title: 'Chat Rooms', cls: 'dialog wide' }, async (win) => {
    const publicList = h('div', { class: 'list sunken rooms-list' }, h('div', { class: 'muted small', text: 'Loading…' }));
    const privName = h('input', { type: 'text', maxlength: '32', placeholder: 'e.g. Weekend Plans' });
    const privMsg = h('p', { class: 'small', role: 'status' });
    const privForm = h('form', { class: 'field' },
      h('label', { class: 'field' }, 'Room name', privName),
      privMsg,
      h('div', { class: 'row end' }, h('button', { type: 'submit', text: 'Create & Invite' })));
    privForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!privName.value.trim()) return;
      try {
        const r = await api('POST', '/api/rooms/create', { name: privName.value, kind: 'private' });
        await loadRooms();
        await ensureRoomKey(r.id);
        win.close();
        openRoom(r.id);
        inviteToRoomDialog(r.id);
      } catch (err) {
        privMsg.className = 'small error';
        privMsg.textContent = err.message;
      }
    });

    const render = async () => {
      let data;
      try {
        data = await loadRooms();
      } catch (err) {
        publicList.replaceChildren(h('div', { class: 'error small', text: err.message }));
        return;
      }
      publicList.replaceChildren(...(data.public.length ? data.public.map((r) => h('div', { class: 'room-row' },
        h('div', { class: 'grow' },
          h('div', { class: 'room-name', text: `# ${r.name}` }),
          r.topic ? h('div', { class: 'small muted', text: r.topic }) : null),
        h('span', { class: 'small muted', text: `${r.online} here` }),
        h('button', {
          type: 'button', text: r.joined ? 'Open' : 'Join',
          onclick: async () => {
            try {
              if (r.joined) openRoom(r.id);
              else await joinPublicRoom(r.id);
              win.close();
            } catch (err) { alertBox('Join Room', err.message); }
          },
        }))) : [h('div', { class: 'muted small', text: 'No public rooms yet.' })]));
    };

    let adminForm = null;
    if (S.me.isAdmin) {
      const pubName = h('input', { type: 'text', maxlength: '32', placeholder: 'e.g. Lobby' });
      const pubTopic = h('input', { type: 'text', maxlength: '120', placeholder: 'Topic (optional)' });
      const pubMsg = h('p', { class: 'small', role: 'status' });
      adminForm = h('form', { class: 'field' },
        h('label', { class: 'field' }, 'Room name', pubName),
        h('label', { class: 'field' }, 'Topic', pubTopic),
        pubMsg,
        h('div', { class: 'row end' }, h('button', { type: 'submit', text: 'Create Public Room' })));
      adminForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/api/rooms/create', { name: pubName.value, topic: pubTopic.value, kind: 'public' });
          pubName.value = pubTopic.value = '';
          pubMsg.className = 'small ok';
          pubMsg.textContent = 'Created.';
          render();
        } catch (err) {
          pubMsg.className = 'small error';
          pubMsg.textContent = err.message;
        }
      });
    }

    win.body.append(
      h('fieldset', {}, h('legend', { text: '# Public rooms' }),
        h('p', { class: 'hint', text: 'Open to everyone here. Not end-to-end encrypted, and nothing is saved.' }),
        publicList),
      h('fieldset', {}, h('legend', { text: '🔒 Start a private room' }),
        h('p', { class: 'hint', text: 'Invite-only and end-to-end encrypted. Invite buddies after creating it.' }),
        privForm),
      adminForm ? h('fieldset', {}, h('legend', { text: 'Admin: new public room' }), adminForm) : null,
      h('div', { class: 'row end' }, h('button', { type: 'button', text: 'Close', onclick: () => win.close() })));
    render();
  });
}

// ===========================================================================
// Dialogs

function addBuddyDialog() {
  dialog('add', { title: 'Add Buddy' }, (win) => {
    const name = h('input', { type: 'text', maxlength: '20', spellcheck: 'false', autocapitalize: 'off' });
    const msg = h('p', { class: 'small', role: 'status' });
    const go = h('button', { type: 'submit', text: 'Send Request' });
    const form = h('form', { class: 'field' },
      h('label', { class: 'field' }, "Buddy's screen name", name),
      h('p', { class: 'hint', text: "They'll get a request. You'll see each other online once they accept." }),
      msg, h('div', { class: 'row end' }, go, h('button', { type: 'button', text: 'Close', onclick: () => win.close() })));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!name.value.trim()) return;
      go.disabled = true;
      try {
        const r = await api('POST', '/api/buddies/request', { screenName: name.value.trim() });
        const display = r.screenName || name.value.trim();
        msg.className = 'small ok';
        msg.textContent = r.status === 'accepted' ? `${display} was added to your Buddy List!` : `Request sent to ${display}.`;
        if (r.status !== 'accepted' && r.screenName && !S.outgoing.includes(r.screenName)) S.outgoing.push(r.screenName);
        renderBuddyList();
        name.value = '';
      } catch (err) {
        msg.className = 'small error';
        msg.textContent = err.message;
      }
      go.disabled = false;
    });
    win.body.append(form);
  });
}

function buddyInfo(buddy) {
  const key = `info:${buddy.norm}`;
  dialogs.get(key)?.close();
  dialog(key, { title: `Buddy Info: ${buddy.screenName}`, cls: 'dialog wide' }, async (win) => {
    const b = S.buddies.get(buddy.norm) || buddy;
    const groups = [...new Set(['Buddies', 'Family', 'Co-Workers', ...[...S.buddies.values()].map((x) => x.group)])];
    const select = h('select', {}, ...groups.map((g) => h('option', { value: g, text: g, selected: g === b.group })),
      h('option', { value: '__new', text: 'New group…' }));
    select.addEventListener('change', async () => {
      let g = select.value;
      if (g === '__new') {
        g = (prompt('Name for the new group:') || '').trim();
        if (!g) {
          select.value = b.group;
          return;
        }
        select.insertBefore(h('option', { value: g, text: g }), select.lastChild);
        select.value = g;
      }
      try {
        await api('POST', '/api/buddies/group', { screenName: b.screenName, group: g });
        b.group = g;
        renderBuddyList();
      } catch (err) {
        alertBox('Group', err.message);
        select.value = b.group;
      }
    });

    const numbers = await C.safetyNumber(S.me.norm, S.me.publicKey, b.norm, b.publicKey);
    const verified = h('input', { type: 'checkbox', checked: b.keyStatus === 'verified' });
    verified.addEventListener('change', () => setPin(b, verified.checked));

    const status = b.online ? (b.away ? `Away: ${b.awayMessage}` : 'Online') : 'Offline';
    win.body.append(
      h('div', {}, h('strong', { text: b.screenName }), ' — ', status),
      h('label', { class: 'field' }, 'Group', select),
      h('fieldset', {},
        h('legend', { text: '🔒 Safety number' }),
        b.keyStatus === 'changed'
          ? h('div', { class: 'banner-warn' },
            h('strong', { text: `${b.screenName}'s encryption key has changed.` }),
            ' This can mean the server is trying to intercept your messages. Keys in this app never change on their own. Compare the number below with them in person or over a call before accepting.')
          : null,
        h('div', { class: 'safety sunken' }, ...numbers.map((n) => h('span', { text: n }))),
        h('p', { class: 'hint', text: `Compare these numbers with ${b.screenName} in person or on a call. If they match on both screens, nobody (not even the server) can read your messages.` }),
        b.keyStatus === 'changed'
          ? h('button', { type: 'button', text: 'Numbers match — accept new key', onclick: async () => { await setPin(b, true); win.close(); } })
          : h('label', { class: 'check' }, verified, 'Mark as verified')),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', text: 'Send IM', onclick: () => { win.close(); openIm(b); } }),
        h('span', { class: 'grow' }),
        h('button', {
          type: 'button', text: 'Remove',
          onclick: async () => {
            if (!confirm(`Remove ${b.screenName} from your Buddy List? You'll both be removed from each other's lists.`)) return;
            try {
              await api('POST', '/api/buddies/remove', { screenName: b.screenName });
              win.close();
            } catch (err) { alertBox('Remove', err.message); }
          },
        }),
        h('button', {
          type: 'button', text: 'Block',
          onclick: async () => {
            if (!confirm(`Block ${b.screenName}? They'll be removed and can't send you requests.`)) return;
            try {
              await api('POST', '/api/block', { screenName: b.screenName });
              if (!S.blocked.includes(b.screenName)) S.blocked.push(b.screenName);
              win.close();
            } catch (err) { alertBox('Block', err.message); }
          },
        })));
  });
}

const AWAY_PRESETS = [
  "I'm away from my computer right now.",
  'brb',
  'Out to lunch. Leave a message!',
  'Sleeping. zzz',
  'At work. Will reply later.',
];

function setAway(on, message = '') {
  S.away = { on, message };
  S.autoReplied.clear();
  wsSend({ t: 'status', away: on, awayMessage: message });
  renderBuddyList();
}

function awayDialog() {
  dialog('away', { title: 'Away Message' }, (win) => {
    const text = h('textarea', { rows: '4', maxlength: '500' });
    text.value = S.away.message || prefs.get('lastAway', AWAY_PRESETS[0]);
    const presets = h('select', {}, h('option', { value: '', text: 'Choose a message…' }), ...AWAY_PRESETS.map((p) => h('option', { value: p, text: p })));
    presets.addEventListener('change', () => { if (presets.value) text.value = presets.value; });
    win.body.append(
      presets,
      h('label', { class: 'field' }, 'Away message', text),
      h('p', { class: 'hint', text: 'Buddies see this on your Buddy List entry and as an auto-response. Unlike IMs, away messages pass through the server unencrypted, so keep them casual.' }),
      h('div', { class: 'row end' },
        S.away.on ? h('button', { type: 'button', text: "I'm Back", onclick: () => { setAway(false); win.close(); } }) : null,
        h('button', {
          type: 'button', text: "I'm Away",
          onclick: () => {
            const m = text.value.trim().slice(0, 500) || AWAY_PRESETS[0];
            prefs.set('lastAway', m);
            setAway(true, m);
            win.close();
          },
        }),
        h('button', { type: 'button', text: 'Cancel', onclick: () => win.close() })));
  });
}

function copyButton(text, label = 'Copy') {
  const btn = h('button', { type: 'button', text: label });
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied!';
    } catch {
      btn.textContent = 'Select & copy manually';
    }
    setTimeout(() => { btn.textContent = label; }, 2000);
  });
  return btn;
}

function inviteDialog() {
  dialog('invite', { title: 'Invite a Friend' }, (win) => {
    const out = h('div');
    const go = h('button', { type: 'button', text: 'Create Invite Code' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const r = await api('POST', '/api/invites', {});
        out.replaceChildren(
          h('div', { class: 'code sunken', text: r.code }),
          h('div', { class: 'row end' }, copyButton(r.code)),
          h('p', { class: 'hint', text: `Works once, expires ${new Date(r.expiresAt).toLocaleDateString()}. Send it to your friend privately along with this site's address.` }));
      } catch (err) {
        out.replaceChildren(h('p', { class: 'error', text: err.message }));
      }
      go.disabled = false;
    });
    win.body.append(
      h('p', { text: 'New people can only sign up with an invite code from an existing member.' }),
      out,
      S.me.isAdmin ? h('p', { class: 'hint' }, 'Inviting lots of people (like your followers)? ',
        h('button', { type: 'button', class: 'linkish', text: 'Make a campaign code', onclick: () => { win.close(); adminDialog(); } }),
        ' that many people can use.') : null,
      h('div', { class: 'row end' }, go, h('button', { type: 'button', text: 'Close', onclick: () => win.close() })));
  });
}

// ---- Admin tools ---------------------------------------------------------------

const CAMPAIGN_DURATIONS = [
  ['24 hours', 24], ['48 hours', 48], ['1 week', 168], ['30 days', 720], ['1 year', 8760],
];

function adminDialog() {
  if (!S.me.isAdmin) return;
  dialog('admin', { title: 'Admin Tools', cls: 'dialog wide' }, (win) => {
    // -- Campaign codes
    const code = h('input', { type: 'text', maxlength: '32', placeholder: 'Leave blank for a random code', autocapitalize: 'characters', spellcheck: 'false' });
    const uses = h('input', { type: 'number', min: '1', max: '100000', value: '300', inputmode: 'numeric' });
    const hours = h('select', {}, ...CAMPAIGN_DURATIONS.map(([label, n]) => h('option', { value: String(n), text: label, selected: n === 48 })));
    const made = h('div', { role: 'status' });
    const list = h('div', { class: 'list sunken campaigns' });
    const create = h('button', { type: 'submit', text: 'Create Code' });
    const form = h('form', { class: 'field' },
      h('label', { class: 'field' }, 'Code', code),
      h('div', { class: 'row' },
        h('label', { class: 'field grow' }, 'Max sign-ups', uses),
        h('label', { class: 'field grow' }, 'Lasts', hours)),
      h('div', { class: 'row end' }, create),
      made);

    const renderCampaigns = async () => {
      let rows;
      try {
        rows = (await api('GET', '/api/admin/campaigns')).campaigns;
      } catch (err) {
        list.replaceChildren(h('div', { class: 'error small', text: err.message }));
        return;
      }
      if (!rows.length) {
        list.replaceChildren(h('div', { class: 'muted small', text: 'No campaign codes yet.' }));
        return;
      }
      list.replaceChildren(...rows.map((c) => h('div', { class: `campaign ${c.status}` },
        h('div', { class: 'grow' },
          h('div', { class: 'campaign-code', text: c.code }),
          h('div', { class: 'small muted', text: `${c.uses} / ${c.maxUses} signed up · ${
            c.status === 'expired' ? 'expired' : c.status === 'full' ? 'full' : `until ${new Date(c.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`}` })),
        c.status === 'active' ? copyButton(c.code) : null,
        c.status !== 'expired' ? h('button', {
          type: 'button', text: 'Revoke',
          onclick: async () => {
            if (!confirm(`Stop "${c.code}" working? People who already signed up keep their accounts.`)) return;
            try {
              await api('POST', '/api/admin/campaigns/revoke', { code: c.code });
              renderCampaigns();
            } catch (err) { alertBox('Revoke', err.message); }
          },
        }) : null)));
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      create.disabled = true;
      try {
        const r = await api('POST', '/api/admin/campaigns', { code: code.value.trim(), uses: Number(uses.value), hours: Number(hours.value) });
        code.value = '';
        made.replaceChildren(
          h('div', { class: 'code sunken', text: r.code }),
          h('div', { class: 'row end' }, copyButton(`${r.code}`, 'Copy Code'), copyButton(`${location.origin}  code: ${r.code}`, 'Copy Link + Code')),
          h('p', { class: 'hint', text: `Up to ${r.maxUses} people can sign up with it until ${new Date(r.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. Post it with the site address: ${location.origin}` }));
        renderCampaigns();
      } catch (err) {
        made.replaceChildren(h('p', { class: 'small error', text: err.message }));
      }
      create.disabled = false;
    });

    // -- Admins (owner only)
    let adminsSection = null;
    if (S.me.isOwner) {
      const adminList = h('div', { class: 'list sunken' });
      const name = h('input', { type: 'text', maxlength: '20', placeholder: 'Screen name', spellcheck: 'false', autocapitalize: 'off' });
      const msg = h('p', { class: 'small', role: 'status' });
      const renderAdmins = async () => {
        try {
          const { admins } = await api('GET', '/api/admin/admins');
          adminList.replaceChildren(...admins.map((a) => h('div', { class: 'row' },
            h('span', { class: 'grow', text: a.screenName }),
            a.owner ? h('span', { class: 'small muted', text: 'owner' }) : h('button', {
              type: 'button', text: 'Remove',
              onclick: async () => {
                if (!confirm(`Remove admin rights from ${a.screenName}?`)) return;
                try {
                  await api('POST', '/api/admin/admins', { screenName: a.screenName, admin: false });
                  renderAdmins();
                } catch (err) { alertBox('Admins', err.message); }
              },
            }))));
        } catch (err) {
          adminList.replaceChildren(h('div', { class: 'error small', text: err.message }));
        }
      };
      const addForm = h('form', { class: 'row' }, name, h('button', { type: 'submit', text: 'Make Admin' }));
      addForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!name.value.trim()) return;
        if (!confirm(`Make ${name.value.trim()} an admin? They'll be able to make campaign codes and run public rooms.`)) return;
        try {
          const r = await api('POST', '/api/admin/admins', { screenName: name.value.trim(), admin: true });
          msg.className = 'small ok';
          msg.textContent = `${r.screenName} is now an admin.`;
          name.value = '';
          renderAdmins();
        } catch (err) {
          msg.className = 'small error';
          msg.textContent = err.message;
        }
      });
      adminsSection = h('fieldset', {}, h('legend', { text: 'Admins' }),
        h('p', { class: 'hint', text: 'Admins can make campaign codes and create and moderate public chat rooms. Only you can add or remove admins.' }),
        adminList, addForm, msg);
      renderAdmins();
    }

    win.body.append(
      h('fieldset', {}, h('legend', { text: 'Campaign codes' }),
        h('p', { class: 'hint', text: 'One code many people can use, like in an Instagram story. Set how many sign-ups it allows and how long it lasts. Revoke it any time if it spreads further than you wanted.' }),
        form),
      h('fieldset', {}, h('legend', { text: 'Your codes' }), list),
      adminsSection,
      h('div', { class: 'row end' }, h('button', { type: 'button', text: 'Close', onclick: () => win.close() })));
    win.el.style.maxHeight = 'calc(100% - 8px)';
    win.body.style.overflowY = 'auto';
    renderCampaigns();
  });
}

function setupDialog() {
  dialog('setup', { title: 'Setup', cls: 'dialog wide' }, (win) => {
    const soundBox = h('input', { type: 'checkbox', checked: prefs.get('sounds', true) });
    soundBox.addEventListener('change', () => {
      prefs.set('sounds', soundBox.checked);
      setSoundEnabled(soundBox.checked);
    });
    const tsBox = h('input', { type: 'checkbox', checked: prefs.get('timestamps', true) });
    tsBox.addEventListener('change', () => {
      prefs.set('timestamps', tsBox.checked);
      for (const el of document.querySelectorAll('.transcript')) el.classList.toggle('hide-ts', !tsBox.checked);
    });

    // Change password: re-encrypt the identity key under the new password.
    const oldP = h('input', { type: 'password', autocomplete: 'current-password' });
    const newP = h('input', { type: 'password', autocomplete: 'new-password' });
    const newP2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const pwMsg = h('p', { class: 'small', role: 'status' });
    const pwBtn = h('button', { type: 'submit', text: 'Change Password' });
    const pwForm = h('form', { class: 'field' },
      h('label', { class: 'field' }, 'Current password', oldP),
      h('label', { class: 'field' }, 'New password (10+ characters)', newP),
      h('label', { class: 'field' }, 'Confirm new password', newP2),
      pwMsg, h('div', { class: 'row end' }, pwBtn));
    pwForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fail = (m) => { pwMsg.className = 'small error'; pwMsg.textContent = m; pwBtn.disabled = false; };
      if (newP.value.length < 10) return fail('Use at least 10 characters.');
      if (newP.value !== newP2.value) return fail("New passwords don't match.");
      pwBtn.disabled = true;
      pwMsg.className = 'small';
      pwMsg.textContent = 'Re-encrypting your keys…';
      try {
        const oldK = await C.deriveAccountKeys(S.me.norm, oldP.value);
        const newK = await C.deriveAccountKeys(S.me.norm, newP.value);
        let wrappedKey;
        try {
          wrappedKey = await C.rewrapIdentity(S.me.wrappedKey, oldK.wrapKey, newK.wrapKey, S.me.norm);
        } catch {
          return fail('Your current password is incorrect.');
        }
        await api('POST', '/api/password', { oldAuthKey: oldK.authKey, newAuthKey: newK.authKey, wrappedKey });
        S.me.wrappedKey = wrappedKey;
        oldP.value = newP.value = newP2.value = '';
        pwMsg.className = 'small ok';
        pwMsg.textContent = 'Password changed. Other signed-on sessions were signed off.';
        pwBtn.disabled = false;
      } catch (err) {
        fail(err.message);
      }
    });

    const blockedList = h('div', { class: 'list sunken' });
    const renderBlocked = () => {
      blockedList.replaceChildren(...(S.blocked.length ? S.blocked.map((n) => h('div', { class: 'row' },
        h('span', { class: 'grow', text: n }),
        h('button', {
          type: 'button', text: 'Unblock',
          onclick: async () => {
            try {
              await api('POST', '/api/unblock', { screenName: n });
              S.blocked = S.blocked.filter((x) => x !== n);
              renderBlocked();
            } catch (err) { alertBox('Unblock', err.message); }
          },
        }))) : [h('div', { class: 'muted small', text: 'Nobody is blocked.' })]));
    };
    renderBlocked();

    const delP = h('input', { type: 'password', autocomplete: 'current-password' });
    const delMsg = h('p', { class: 'small error', role: 'status' });
    const delBtn = h('button', { type: 'submit', text: 'Delete My Account' });
    const delForm = h('form', { class: 'field' },
      h('p', { class: 'hint', text: 'Permanently deletes your screen name, keys, buddy list and any undelivered messages from the server. This cannot be undone.' }),
      h('label', { class: 'field' }, 'Password', delP), delMsg, h('div', { class: 'row end' }, delBtn));
    delForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!confirm('Really delete your account forever?')) return;
      delBtn.disabled = true;
      try {
        const k = await C.deriveAccountKeys(S.me.norm, delP.value);
        await api('POST', '/api/account/delete', { authKey: k.authKey });
        prefs.set(pinsKey(), undefined);
        if (C.normalizeScreenName(prefs.get('screenName', '')) === S.me.norm) prefs.set('screenName', undefined);
        signOff('Your account was deleted.', { skipServer: true });
      } catch (err) {
        delMsg.textContent = err.message;
        delBtn.disabled = false;
      }
    });

    win.body.append(
      S.me.isAdmin ? h('fieldset', {}, h('legend', { text: 'Admin' }),
        h('div', { class: 'row' },
          h('span', { class: 'grow small', text: S.me.isOwner ? 'Campaign codes and admins' : 'Campaign codes' }),
          h('button', { type: 'button', text: 'Admin Tools', onclick: () => { win.close(); adminDialog(); } }))) : null,
      h('fieldset', {}, h('legend', { text: 'Preferences' }),
        h('label', { class: 'check' }, soundBox, 'Play sounds'),
        h('label', { class: 'check' }, tsBox, 'Show timestamps')),
      h('fieldset', {}, h('legend', { text: 'Change password' }), pwForm),
      h('fieldset', {}, h('legend', { text: 'Blocked' }), blockedList),
      h('fieldset', {}, h('legend', { text: 'Delete account' }), delForm),
      h('div', { class: 'row end' }, h('button', { type: 'button', text: 'Close', onclick: () => win.close() })));
    win.el.style.maxHeight = 'calc(100% - 8px)';
    win.body.style.overflowY = 'auto';
  });
}

// ===========================================================================
// Boot

(async () => {
  try {
    // Clear any stale session from a previous page load: keys live in memory only.
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch { /* offline */ }
  showSignOn();
})();

// Reloading or closing the tab signs you off, so ask first (desktop browsers honor this).
window.addEventListener('beforeunload', (e) => {
  if (!S) return;
  e.preventDefault();
  e.returnValue = '';
});
window.addEventListener('pagehide', () => {
  if (S) navigator.sendBeacon?.('/api/logout', new Blob(['{}'], { type: 'application/json' }));
});
