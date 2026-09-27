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
        await api('POST', '/api/register', {
          screenName, inviteCode: invite.value.trim(), authKey: keys.authKey,
          publicKey: id.publicKey, wrappedKey: id.wrappedKey,
        });
        me = { screenName, norm: keys.norm, publicKey: id.publicKey, wrappedKey: id.wrappedKey, privateKey: id.privateKey };
      } else {
        setStep(2, 'Verifying password…');
        const r = await api('POST', '/api/login', { screenName, authKey: keys.authKey });
        setStep(3, 'Unlocking encryption keys…');
        const privateKey = await C.unwrapIdentity(r.wrappedKey, keys.wrapKey, keys.norm);
        me = { screenName: r.screenName, norm: keys.norm, publicKey: r.publicKey, wrappedKey: r.wrappedKey, privateKey };
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
    if (state.connectedBefore) loadBuddies().catch(() => {});
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
      const norm = S.pending.get(msg.id);
      S.pending.delete(msg.id);
      if (msg.queued && norm) {
        const b = S.buddies.get(norm);
        S.ims.get(norm)?.sys(`${b?.screenName ?? 'Your buddy'} is offline. The encrypted message will be delivered when they sign on.`);
      }
      return;
    }
    case 'error': {
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
    x: Math.max(0, desktop.clientWidth - 260), y: 16,
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
      btn('Away', awayDialog, 'Set an away message'),
      btn('Invite', inviteDialog, 'Invite a friend'),
      btn('Setup', setupDialog, 'Preferences & account')),
    h('div', { class: 'row' }, h('span', { class: 'grow' }), btn('Sign Off', () => signOff()), h('span', { class: 'grow' })),
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
  if (!all.length && !S.incoming.length && !S.outgoing.length) {
    blTree.append(h('p', { class: 'hint', text: 'Your Buddy List is empty. Click "Add" to add a friend by screen name, or "Invite" to get a friend signed up.' }));
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

function inviteDialog() {
  dialog('invite', { title: 'Invite a Friend' }, (win) => {
    const out = h('div');
    const go = h('button', { type: 'button', text: 'Create Invite Code' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const r = await api('POST', '/api/invites', {});
        const copy = h('button', { type: 'button', text: 'Copy' });
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(r.code);
            copy.textContent = 'Copied!';
          } catch {
            copy.textContent = 'Select & copy manually';
          }
        });
        out.replaceChildren(
          h('div', { class: 'code sunken', text: r.code }),
          h('div', { class: 'row end' }, copy),
          h('p', { class: 'hint', text: `Works once, expires ${new Date(r.expiresAt).toLocaleDateString()}. Send it to your friend privately along with this site's address.` }));
      } catch (err) {
        out.replaceChildren(h('p', { class: 'error', text: err.message }));
      }
      go.disabled = false;
    });
    win.body.append(
      h('p', { text: 'New people can only sign up with an invite code from an existing member.' }),
      out,
      h('div', { class: 'row end' }, go, h('button', { type: 'button', text: 'Close', onclick: () => win.close() })));
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
