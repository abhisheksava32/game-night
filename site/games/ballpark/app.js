import { QUESTIONS } from './questions.js';
import { parseGuess, scoreRound, pickWinners, cleanName, ordinal, POINTS_BULLSEYE } from './rules.js';

/* ------------------------------------------------------------------ *
 * Setup
 *
 * Players talk to each other through a public MQTT relay. The host's
 * browser owns the game: it receives every player's actions, runs the
 * rules and publishes one shared game state that everyone renders.
 * ------------------------------------------------------------------ */

const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081',
];
const NS = 'ballpark-party/v1';
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const REVEAL_MS = 15000;      // reveal screen auto-advances after this
const AWAY_MS = 15000;        // a player is "away" after this long without a ping
const HEARTBEAT_MS = 3000;    // host re-publishes state at least this often
const RESEND_MS = 1500;       // players re-send unconfirmed actions this often
const PING_MS = 5000;
const HOST_SILENT_MS = 12000; // players warn after this long without hearing the host
const GRACE_MS = 1000;        // guesses locked in on time may still be in transit at the deadline
const STALE_ROOM_MS = 10 * 60 * 1000; // a stored room this old has no host any more
const MAX_ACT_BYTES = 1024;   // real actions are under 200 bytes
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
const COLORS = ['#ffc93c', '#5ec8f2', '#ff7ab6', '#7be495', '#ff9a52', '#b99bff', '#ff6b5e', '#4fd1c5'];
const ROUND_CHOICES = [5, 7, 10];
const SECOND_CHOICES = [20, 30, 45];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const T = (code, kind) => `${NS}/${code}/${kind}`;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

function rid(n = 12) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}
function randInt(n) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
}
function fmt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '?';
  return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
}
const withUnit = (n, u) => (u ? `${fmt(n)} ${u}` : fmt(n));
const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#a8c1b5');
const initial = (name) => esc((Array.from(String(name || '?').trim())[0] || '?').toUpperCase());

function store(area) {
  const key = (k) => `bp:${k}`;
  return {
    get(k) { try { return JSON.parse(area.getItem(key(k))); } catch { return null; } },
    set(k, v) { try { area.setItem(key(k), JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k) { try { area.removeItem(key(k)); } catch { /* storage unavailable */ } },
  };
}
const session = store(sessionStorage); // per tab, survives refresh
const local = store(localStorage);     // remembers your name

function me() {
  let m = session.get('me');
  if (!m || !m.id || !m.secret) {
    m = { id: rid(10), secret: rid(16) };
    session.set('me', m);
  }
  return m;
}

/* ------------------------------------------------------------------ *
 * App state
 * ------------------------------------------------------------------ */

let role = null;     // 'host' | 'player' | null
let net = null;      // { client, broker, code }
let ST = null;       // latest shared game state
let H = null;        // host only: the full game, including secrets and answers
let skew = 0;        // host clock minus our clock
let lastLive = 0;    // when we last heard a live state message
let myName = '';
let myGuess = null;  // { round, dl, value } - dl is that round's deadline, unique per question
let shownRound = null;
let curScreen = null;
let lastTickAt = 0;  // host: when hostTick last ran
let deafUntil = 0;   // host: hold timers until players have had a chance to re-send
let lastKey = '';
let loops = [];
let lastPing = 0;
let lastPublish = 0;
let publishQueued = false;
let joinAttempt = null;
let wakeLock = null;

/* ------------------------------------------------------------------ *
 * Networking
 * ------------------------------------------------------------------ */

function connectBroker(idx, ms = 7000) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(BROKERS[idx], {
      clientId: `bp_${rid(10)}`,
      keepalive: 20,
      reconnectPeriod: 2000,
      connectTimeout: ms,
      clean: true,
      resubscribe: true,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.end(true);
      reject(new Error('timeout'));
    }, ms + 500);
    client.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(client);
    });
    client.on('error', () => { /* retried by the client; the timeout handles give-up */ });
  });
}

function attach(client, broker, code) {
  net = { client, broker, code };
  client.on('message', onMessage);
  client.on('connect', () => {
    setConn('ok');
    if (role === 'host') publishState();
    if (role === 'player') playerTick();
  });
  client.on('reconnect', () => setConn('warn'));
  client.on('close', () => setConn('warn'));
  client.on('offline', () => setConn('bad'));
  setConn(client.connected ? 'ok' : 'warn');
}

function onMessage(topic, payload, packet) {
  if (!net || !payload || !payload.length) return;
  const isAct = topic === T(net.code, 'act');
  if (isAct && payload.length > MAX_ACT_BYTES) return;
  let msg;
  try { msg = JSON.parse(payload.toString()); } catch { return; }
  // A bad message must never break the message pump.
  try {
    if (role === 'player' && topic === T(net.code, 'state')) applyState(msg, packet.retain);
    else if (role === 'host' && isAct) hostHandle(msg);
  } catch (err) {
    console.warn('Ignored a bad message', err);
  }
}

/** Checks whether a room code already has a game on this relay. */
function codeTaken(client, code) {
  return new Promise((resolve) => {
    const topic = T(code, 'state');
    let taken = false;
    const onMsg = (t, p) => { if (t === topic && p && p.length) taken = true; };
    client.on('message', onMsg);
    client.subscribe(topic, () => {
      setTimeout(() => {
        client.removeListener('message', onMsg);
        client.unsubscribe(topic);
        resolve(taken);
      }, 900);
    });
  });
}

/**
 * Finds which relay a room lives on. Invite links carry a hint; otherwise we
 * ask every relay at once. A live message (host is online right now) beats a
 * stored one, which might be left over from an old game.
 */
async function findRoom(code, hint) {
  const valid = Number.isInteger(hint) && hint >= 0 && hint < BROKERS.length;
  if (valid) {
    const hit = await probeRelays([hint], code, 4500);
    if (hit) return hit;
  }
  const rest = BROKERS.map((_, i) => i).filter((i) => !valid || i !== hint);
  return probeRelays(rest, code, 6500);
}

function probeRelays(indexes, code, ms) {
  return new Promise((resolve) => {
    const open = [];
    let best = null;
    let done = false;
    const topic = T(code, 'state');
    const finish = (win) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const o of open) {
        o.client.removeListener('message', o.onMsg);
        if (!win || o.client !== win.client) o.client.end(true);
      }
      resolve(win);
    };
    const timer = setTimeout(() => finish(best), ms);
    for (const idx of indexes) {
      connectBroker(idx, ms).then((client) => {
        if (done) { client.end(true); return; }
        const onMsg = (t, p, packet) => {
          if (t !== topic || !p || !p.length) return;
          let s;
          try { s = JSON.parse(p.toString()); } catch { return; }
          if (!s || s.code !== code || typeof s.now !== 'number') return;
          if (packet.retain && Date.now() - s.now > STALE_ROOM_MS) return; // host is long gone
          const hit = { client, idx, state: s, live: !packet.retain };
          if (hit.live) finish(hit);
          else if (!best || s.now > best.state.now) best = hit;
        };
        open.push({ client, onMsg });
        client.on('message', onMsg);
        client.subscribe(topic);
      }).catch(() => { /* this relay is unreachable */ });
    }
  });
}

function send(type, data = {}) {
  const m = me();
  const msg = { t: type, pid: m.id, sec: m.secret, ...data };
  if (role === 'host') { hostHandle(msg); return; }
  if (net?.client) net.client.publish(T(net.code, 'act'), JSON.stringify(msg), { qos: 0 });
}

/* ------------------------------------------------------------------ *
 * Host: the game itself
 * ------------------------------------------------------------------ */

function makeCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_LETTERS[randInt(CODE_LETTERS.length)];
  return c;
}

function nextColor() {
  const used = new Set(H.players.map((p) => p.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[H.players.length % COLORS.length];
}

function uniqueName(name, id) {
  const base = name || 'Player';
  let n = base;
  let k = 2;
  while (H.players.some((p) => p.id !== id && p.name.toLowerCase() === n.toLowerCase())) {
    n = `${base.slice(0, 13)} ${k++}`;
  }
  return n;
}

function pickQuestions(n) {
  let pool = QUESTIONS.map((_, i) => i).filter((i) => !H.used.includes(i));
  if (pool.length < n) { H.used = []; pool = QUESTIONS.map((_, i) => i); }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const chosen = pool.slice(0, n);
  H.used.push(...chosen);
  return chosen;
}

const activePlayers = () => H.players.filter((p) => !p.away);
const everyoneLocked = () => {
  const active = activePlayers();
  return active.length > 0 && active.every((p) => p.id in H.guesses);
};

function hostHandle(a) {
  if (!H || !a || typeof a !== 'object') return;
  // Ids and secrets are made by rid(10) and rid(16). Anything else is not one of ours.
  if (typeof a.pid !== 'string' || !/^[0-9a-z]{10}$/.test(a.pid)) return;
  if (typeof a.sec !== 'string' || !/^[0-9a-z]{16}$/.test(a.sec)) return;
  const now = Date.now();
  const p = H.players.find((x) => x.id === a.pid);

  if (a.t === 'join') {
    if (H.phase === 'closed') return;
    const name = cleanName(a.name);
    if (p) {
      if (p.secret !== a.sec) return;
      p.lastSeen = now;
      if (p.away || p.left) { p.away = false; p.left = false; changed(); }
      return;
    }
    const seated = H.players.filter((x) => !x.left);
    if (seated.length >= MAX_PLAYERS) {
      if (!Object.hasOwn(H.rejected, a.pid) && Object.keys(H.rejected).length < 16) {
        H.rejected[a.pid] = now;
        changed();
      }
      return;
    }
    if (H.players.length >= MAX_PLAYERS) H.players = seated; // free the seats of players who left
    H.players.push({
      id: a.pid, secret: a.sec, name: uniqueName(name, a.pid), color: nextColor(),
      score: 0, lastSeen: now, away: false, left: false,
    });
    changed();
    return;
  }

  if (!p || p.secret !== a.sec) return;
  p.lastSeen = now;
  if (a.t !== 'leave' && (p.away || p.left)) { p.away = false; p.left = false; changed(); }

  if (a.t === 'guess') {
    if (H.phase !== 'question' || a.round !== H.round || Object.hasOwn(H.guesses, p.id)) return;
    if (now > Math.max(H.deadline + GRACE_MS, deafUntil)) return;
    if (typeof a.value !== 'number' || !Number.isFinite(a.value) || Math.abs(a.value) > 1e15) return;
    H.guesses[p.id] = a.value;
    changed();
    if (everyoneLocked()) doReveal();
  } else if (a.t === 'leave') {
    if (p.id === H.hostId) return;
    if (H.phase === 'lobby') H.players = H.players.filter((x) => x !== p);
    else { p.away = true; p.left = true; delete H.guesses[p.id]; }
    changed();
    if (H.phase === 'question' && everyoneLocked()) doReveal();
  }
}

function hostTick() {
  if (!H || role !== 'host') return;
  const now = Date.now();
  // If this page was asleep, offline or just reloaded, players' pings and guesses
  // could not reach us. Give them time to re-send before judging anyone away
  // or ending the round.
  if (now - lastTickAt > 2000 || !net?.client?.connected) deafUntil = now + 2 * RESEND_MS + 1000;
  lastTickAt = now;
  if (now < deafUntil) {
    for (const p of H.players) p.lastSeen = Math.max(p.lastSeen, now);
    if (now - lastPublish >= HEARTBEAT_MS) publishState();
    return;
  }
  let dirty = false;
  for (const p of H.players) {
    if (p.id === H.hostId) { p.lastSeen = now; continue; }
    if (!p.away && now - p.lastSeen > AWAY_MS) { p.away = true; dirty = true; }
  }
  for (const [pid, ts] of Object.entries(H.rejected)) {
    if (now - ts > 30000) { delete H.rejected[pid]; dirty = true; }
  }
  if (H.phase === 'question' && (now >= H.deadline + GRACE_MS || everyoneLocked())) { doReveal(); return; }
  if (H.phase === 'reveal' && now >= H.revealEnds) { advance(); return; }
  if (dirty) changed();
  else if (now - lastPublish >= HEARTBEAT_MS) publishState();
}

function hostSet(key, value) {
  if (!H || H.phase !== 'lobby') return;
  if (key === 'rounds' && ROUND_CHOICES.includes(value)) H.settings.rounds = value;
  if (key === 'seconds' && SECOND_CHOICES.includes(value)) H.settings.seconds = value;
  changed();
}

function startGame() {
  if (!H || H.phase !== 'lobby') return;
  H.players = H.players.filter((p) => p.id === H.hostId || (!p.away && !p.left));
  if (H.players.length < MIN_PLAYERS) { toast('You need at least 2 players to start.'); changed(); return; }
  for (const p of H.players) p.score = 0;
  H.order = pickQuestions(H.settings.rounds);
  H.round = 0;
  H.winners = null;
  nextRound();
}

function nextRound() {
  H.round += 1;
  H.qi = H.order[H.round - 1];
  H.guesses = {};
  H.reveal = null;
  H.deadline = Date.now() + H.settings.seconds * 1000;
  H.phase = 'question';
  changed();
}

function doReveal() {
  if (H.phase !== 'question') return;
  const q = QUESTIONS[H.qi];
  const guesses = {};
  for (const [id, g] of Object.entries(H.guesses)) {
    if (H.players.some((p) => p.id === id && !p.left)) guesses[id] = g;
  }
  // Count everyone still seated who is here or guessed, so a player who locked in
  // and then went quiet still counts towards the 3-player second-place rule.
  const inGame = H.players.filter((p) => !p.left && (!p.away || Object.hasOwn(guesses, p.id))).length;
  const rows = scoreRound(q.a, guesses, inGame);
  for (const r of rows) {
    const p = H.players.find((x) => x.id === r.id);
    if (p) p.score += r.pts;
  }
  H.reveal = {
    q: q.q, a: q.a, u: q.u, f: q.f, rows,
    noGuess: H.players.filter((p) => !(p.id in guesses) && !p.left).map((p) => p.id),
  };
  H.phase = 'reveal';
  H.revealEnds = Date.now() + REVEAL_MS;
  changed();
}

function advance() {
  if (!H || H.phase !== 'reveal') return;
  if (H.round >= H.settings.rounds) {
    H.phase = 'final';
    H.winners = pickWinners(H.players.filter((p) => !p.left));
    changed();
  } else {
    nextRound();
  }
}

function playAgain() {
  if (!H || H.phase !== 'final') return;
  H.players = H.players.filter((p) => p.id === H.hostId || (!p.left && !p.away));
  for (const p of H.players) p.score = 0;
  Object.assign(H, { phase: 'lobby', round: 0, reveal: null, winners: null, guesses: {}, order: [] });
  changed();
}

function publicState() {
  const inRound = H.phase === 'question' || H.phase === 'reveal';
  const q = inRound ? QUESTIONS[H.qi] : null;
  return {
    v: 1,
    code: H.code,
    host: H.hostId,
    b: H.broker,
    phase: H.phase,
    settings: H.settings,
    round: H.round,
    total: H.settings.rounds,
    players: H.players.filter((p) => !p.left).map((p) => ({
      id: p.id, name: p.name, color: p.color, score: p.score, away: !!p.away,
      locked: H.phase === 'question' && p.id in H.guesses,
    })),
    q: q ? { text: q.q, u: q.u } : null,
    deadline: H.phase === 'question' ? H.deadline : 0,
    reveal: H.phase === 'reveal' ? H.reveal : null,
    revealEnds: H.phase === 'reveal' ? H.revealEnds : 0,
    winners: H.phase === 'final' ? H.winners : null,
    rejected: H.rejected,
    seq: ++H.seq,
    now: Date.now(),
  };
}

function changed() {
  if (publishQueued) return;
  publishQueued = true;
  queueMicrotask(() => { publishQueued = false; publishState(); });
}

function publishState() {
  if (!H || role !== 'host') return;
  const s = publicState();
  lastPublish = Date.now();
  session.set('host', H);
  if (net?.client) net.client.publish(T(H.code, 'state'), JSON.stringify(s), { retain: true, qos: 0 });
  applyState(s, false);
}

async function createRoom(name) {
  showBusy('Creating your room…');
  let client = null;
  let broker = -1;
  for (let i = 0; i < BROKERS.length && !client; i++) {
    try { client = await connectBroker(i, 6000); broker = i; } catch { /* try the next relay */ }
  }
  if (!client) {
    hideBusy();
    showError("Couldn't reach the game server. Check your internet connection and try again.");
    return;
  }
  let code = makeCode();
  for (let tries = 0; tries < 4 && (await codeTaken(client, code)); tries++) code = makeCode();

  const m = me();
  H = {
    code, broker, hostId: m.id, seq: 0,
    phase: 'lobby',
    settings: { rounds: 7, seconds: 30 },
    players: [{ id: m.id, secret: m.secret, name, color: COLORS[0], score: 0, lastSeen: Date.now(), away: false, left: false }],
    round: 0, order: [], used: [], qi: null, guesses: {}, deadline: 0,
    reveal: null, revealEnds: 0, winners: null, rejected: {},
  };
  role = 'host';
  myName = name;
  attach(client, broker, code);
  client.subscribe(T(code, 'act'), { qos: 0 });
  enterRoom(code, broker, 'host', name);
  publishState();
  hideBusy();
}

async function resumeHost(saved) {
  // Keep trying until it works or the host presses Cancel (which clears the saved game).
  showBusy('Reconnecting to your room…', true);
  const stillWanted = () => session.get('host')?.code === saved.code;
  let client = null;
  while (!client) {
    try {
      client = await connectBroker(saved.broker, 8000);
    } catch {
      if (!stillWanted()) return;
      showBusy("Still reconnecting to your room… Check your internet connection.", true);
    }
  }
  if (!stillWanted()) { client.end(true); return; }
  H = saved;
  role = 'host';
  myName = H.players.find((p) => p.id === H.hostId)?.name || '';
  attach(client, H.broker, H.code);
  client.subscribe(T(H.code, 'act'), { qos: 0 });
  enterRoom(H.code, H.broker, 'host', myName);
  publishState();
  hideBusy();
}

function closeRoom() {
  const client = net?.client;
  if (H && client) {
    H.phase = 'closed';
    const s = publicState();
    // Stored, so players who were offline find out when they reconnect.
    client.publish(T(H.code, 'state'), JSON.stringify(s), { qos: 1, retain: true });
  }
  leaveLocal({ keepClient: true });
  setTimeout(() => { try { client?.end(false); } catch { /* already closed */ } }, 1200);
  showHome();
}

/* ------------------------------------------------------------------ *
 * Player
 * ------------------------------------------------------------------ */

async function joinRoom(code, name, hint, opts = {}) {
  const attempt = {};
  joinAttempt = attempt;
  showBusy(opts.resume ? `Rejoining room ${code}…` : `Looking for room ${code}…`, true);
  const found = await findRoom(code, hint);
  if (joinAttempt !== attempt) { found?.client.end(true); return; }
  joinAttempt = null;
  if (!found || found.state.phase === 'closed') {
    found?.client.end(true);
    hideBusy();
    session.del('room');
    showHome();
    showError(found ? `Room ${code} has closed.` : `No game found with code ${code}. Check the code with your host.`);
    return;
  }
  // Reuse this browser's seat in this room, so opening the invite link again
  // (or in a new tab) doesn't create a second player.
  let cur = session.get('me');
  if (cur && cur.id === found.state.host && !session.get('host')) { session.del('me'); cur = null; } // copied from the host's tab
  const kept = local.get(`me:${code}`);
  const curIsSeated = !!cur && found.state.players.some((p) => p.id === cur.id);
  if (kept?.id && kept?.secret && kept.id !== found.state.host && !curIsSeated) session.set('me', kept);
  local.set(`me:${code}`, me());

  role = 'player';
  myName = name;
  attach(found.client, found.idx, code);
  found.client.subscribe(T(code, 'state'), { qos: 0 });
  enterRoom(code, found.idx, 'player', name);
  const saved = session.get('guess');
  if (saved && saved.code === code) myGuess = { round: saved.round, dl: saved.dl, value: saved.value };
  applyState(found.state, !found.live);
  send('join', { name });
}

function playerTick() {
  if (role !== 'player' || !ST) return;
  const m = me();
  const now = Date.now();
  const mine = ST.players.find((p) => p.id === m.id);
  if (!mine) {
    if (!(ST.rejected && ST.rejected[m.id])) send('join', { name: myName });
    if (now - lastLive > HOST_SILENT_MS) {
      showBusy(`Room ${ST.code} isn't answering. The host may have left, or their phone may be asleep.`, true);
    }
  } else if (ST.phase === 'question' && sameQuestion(myGuess) && !mine.locked) {
    send('guess', { round: myGuess.round, value: myGuess.value });
  }
  if (now - lastPing >= PING_MS) { lastPing = now; send('ping'); }
  setBanner(now - lastLive > HOST_SILENT_MS
    ? "Can't reach the host right now. Waiting for them to reconnect…"
    : null);
}

/* ------------------------------------------------------------------ *
 * Rooms: entering and leaving
 * ------------------------------------------------------------------ */

function enterRoom(code, broker, r, name) {
  session.set('room', { code, broker, role: r, name });
  local.set('name', name);
  history.replaceState(null, '', `${location.pathname}?room=${code}&b=${broker}`);
  $('#topbar').hidden = false;
  $('#tb-code').textContent = code;
  lastLive = Date.now();
  loops.push(setInterval(uiTick, 200));
  loops.push(r === 'host' ? setInterval(hostTick, 250) : setInterval(playerTick, RESEND_MS));
  requestWakeLock();
}

function leaveLocal({ keepClient = false } = {}) {
  loops.forEach(clearInterval);
  loops = [];
  const client = net?.client;
  net = null;
  if (client && !keepClient) { try { client.end(false); } catch { /* already closed */ } }
  role = null; ST = null; H = null; myGuess = null; shownRound = null; lastKey = '';
  lastTickAt = 0; deafUntil = 0;
  session.del('room');
  session.del('host');
  session.del('guess');
  history.replaceState(null, '', location.pathname);
  $('#topbar').hidden = true;
  setBanner(null);
  hideBusy();
  releaseWakeLock();
}

function endSession(title, body) {
  leaveLocal();
  $('#msg-title').textContent = title;
  $('#msg-body').textContent = body;
  show('screen-msg');
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function applyState(s, retained) {
  if (!s || typeof s !== 'object' || !net || s.code !== net.code) return;
  if (!Array.isArray(s.players) || typeof s.seq !== 'number' || typeof s.phase !== 'string'
    || typeof s.host !== 'string' || typeof s.now !== 'number') return;
  if (ST && s.host === ST.host && s.seq < ST.seq) return;
  if (!retained) { skew = s.now - Date.now(); lastLive = Date.now(); }
  ST = s;
  render();
}

function show(id) {
  for (const s of $$('.screen')) s.hidden = s.id !== id;
  if (id === curScreen) return;
  curScreen = id;
  window.scrollTo(0, 0);
  $(`#${id} [data-focus]`)?.focus({ preventScroll: true });
}

const findPlayer = (id) => ST?.players.find((p) => p.id === id);
const remainingMs = () => (ST ? ST.deadline - (Date.now() + skew) : 0);
// A saved guess belongs to one specific question: same round and same deadline.
const sameQuestion = (g) => !!g && !!ST && g.round === ST.round && g.dl === ST.deadline;

function avatar(p) {
  return `<span class="avatar" style="background:${safeColor(p?.color)}">${initial(p?.name)}</span>`;
}

function render() {
  if (!ST) return;
  const m = me();
  const mine = ST.players.find((p) => p.id === m.id);
  const isHost = ST.host === m.id;

  if (ST.phase === 'closed') {
    if (role !== 'host') endSession('Room closed', 'The host closed this room. Thanks for playing!');
    return;
  }
  if (!mine && ST.rejected && ST.rejected[m.id]) {
    endSession('Room is full', `Room ${ST.code} already has ${MAX_PLAYERS} players. Ask the host to start a new room.`);
    return;
  }

  const key = JSON.stringify([ST.phase, ST.round, ST.players, ST.settings, ST.reveal, ST.winners, ST.q, !!mine, myGuess]);
  if (key === lastKey) return;
  lastKey = key;

  if (!mine) showBusy(`Joining room ${ST.code}…`, true);
  else hideBusy();

  if (ST.phase === 'lobby') renderLobby(m, isHost);
  else if (ST.phase === 'question') renderQuestion(mine, isHost);
  else if (ST.phase === 'reveal') renderReveal(m, isHost);
  else if (ST.phase === 'final') renderFinal(m, isHost);
}

function inviteUrl() {
  return `${location.origin}${location.pathname}?room=${ST?.code || ''}&b=${net?.broker ?? 0}`;
}

function renderLobby(m, isHost) {
  show('screen-lobby');
  $('#lobby-code').textContent = ST.code;
  $('#share-url').textContent = inviteUrl();
  $('#lobby-count').textContent = `${ST.players.length}/${MAX_PLAYERS}`;
  const items = ST.players.map((p) => `
    <li>
      ${avatar(p)}
      <span class="name">${esc(p.name)}</span>
      ${p.id === ST.host ? '<span class="tag host">Host</span>' : ''}
      ${p.id === m.id ? '<span class="tag">You</span>' : ''}
      ${p.away ? '<span class="tag away">Away</span>' : ''}
    </li>`);
  if (ST.players.length < MIN_PLAYERS) items.push('<li class="empty">Waiting for friends to join…</li>');
  $('#lobby-players').innerHTML = items.join('');

  $('#host-settings').hidden = !isHost;
  $('#guest-wait').hidden = isHost;
  if (isHost) {
    for (const b of $$('#set-rounds button')) b.setAttribute('aria-checked', String(Number(b.dataset.v) === ST.settings.rounds));
    for (const b of $$('#set-seconds button')) b.setAttribute('aria-checked', String(Number(b.dataset.v) === ST.settings.seconds));
    const ready = ST.players.filter((p) => !p.away).length;
    $('#btn-start').disabled = ready < MIN_PLAYERS;
    $('#start-hint').textContent = ready < MIN_PLAYERS
      ? 'Share the room code. You need at least 2 players to start.'
      : `${ready} players ready. Anyone else can still join mid-game.`;
  } else {
    const host = findPlayer(ST.host);
    $('#host-name').textContent = host ? host.name : 'the host';
    $('#guest-settings').textContent = `${ST.settings.rounds} rounds · ${ST.settings.seconds} seconds per question`;
  }
}

function renderQuestion(mine, isHost) {
  show('screen-question');
  $('#q-round').textContent = `Round ${ST.round} of ${ST.total}`;
  $('#q-text').textContent = ST.q?.text || '';
  $('#q-unit').textContent = ST.q?.u || '';

  if (shownRound !== ST.deadline) {
    shownRound = ST.deadline;
    $('#guess').value = '';
    setPreview('');
    if (!sameQuestion(myGuess)) myGuess = null;
  }
  const mineLocal = sameQuestion(myGuess);
  const locked = !!(mine && mine.locked) || mineLocal;
  const timeUp = remainingMs() <= 0;
  $('#guess-form').hidden = locked || timeUp || !mine;
  $('#locked-box').hidden = !locked;
  $('#timeout-box').hidden = locked || !timeUp;
  $('#locked-val').textContent = mineLocal ? withUnit(myGuess.value, ST.q?.u) : 'Locked';

  const active = ST.players.filter((p) => !p.away);
  const done = active.filter((p) => p.locked).length;
  $('#q-status').textContent = `${done} of ${active.length} locked in`;
  $('#q-players').innerHTML = ST.players.map((p) =>
    `<li class="${p.locked ? 'done' : ''} ${p.away ? 'away' : ''}">${avatar(p)}${esc(p.name)}</li>`).join('');
  $('#btn-reveal-now').hidden = !isHost;
}

function renderReveal(m, isHost) {
  show('screen-reveal');
  const R = ST.reveal;
  if (!R) return;
  const last = ST.round >= ST.total;
  $('#r-round').textContent = `Round ${ST.round} of ${ST.total}`;
  $('#r-question').textContent = R.q;
  $('#r-answer').innerHTML = `${esc(fmt(R.a))}${R.u ? `<span class="unit-inline">${esc(R.u)}</span>` : ''}`;
  renderNumberLine(R);

  const rows = R.rows.map((r) => {
    const p = findPlayer(r.id) || { name: 'Player', color: '#a8c1b5' };
    const base = r.pts - (r.bull ? POINTS_BULLSEYE : 0);
    const gains = [];
    if (base > 0) gains.push(`<span class="pts">+${base}</span>`);
    if (r.bull) gains.push(`<span class="pts bull" title="Bullseye: within 10%">+${POINTS_BULLSEYE}</span>`);
    const off = r.d === 0 ? 'spot on!' : `off by ${esc(fmt(r.d))}`;
    return `
      <li class="${r.place === 1 ? 'first' : ''}">
        <span class="place">${esc(ordinal(Number(r.place) || 0))}</span>
        ${avatar(p)}
        <span class="who"><b>${esc(p.name)}${r.id === m.id ? ' (you)' : ''}</b><span>guessed ${esc(withUnit(r.g, R.u))} · ${off}${r.bull ? ' · bullseye' : ''}</span></span>
        <span class="gain">${gains.join('') || '<span class="zero">0</span>'}</span>
      </li>`;
  });
  for (const id of R.noGuess || []) {
    const p = findPlayer(id);
    if (!p) continue;
    rows.push(`
      <li>
        <span class="place">-</span>
        ${avatar(p)}
        <span class="who"><b>${esc(p.name)}${id === m.id ? ' (you)' : ''}</b><span>no guess</span></span>
        <span class="gain"><span class="zero">0</span></span>
      </li>`);
  }
  $('#r-rows').innerHTML = rows.join('');
  $('#r-fact').textContent = R.f || '';

  const gained = Object.fromEntries(R.rows.map((r) => [r.id, r.pts]));
  $('#r-scores').innerHTML = scoreList(m, gained);

  $('#btn-next').hidden = !isHost;
  $('#btn-next').textContent = last ? 'See final results' : 'Next round';
}

function scoreList(m, gained = {}) {
  const score = (p) => Number(p.score) || 0;
  const sorted = [...ST.players].sort((a, b) => score(b) - score(a) || String(a.name).localeCompare(String(b.name)));
  return sorted.map((p) => {
    const rank = 1 + sorted.filter((o) => score(o) > score(p)).length;
    const g = Number(gained[p.id]) || 0;
    return `
      <li class="${p.id === m.id ? 'me' : ''}">
        <span class="rank">${rank}</span>
        ${avatar(p)}
        <span class="name">${esc(p.name)}</span>
        ${g ? `<span class="delta">+${g}</span>` : ''}
        <span class="total">${score(p)}</span>
      </li>`;
  }).join('');
}

function renderNumberLine(R) {
  const el = $('#r-line');
  if (!R.rows.length) { el.hidden = true; return; }
  el.hidden = false;
  const values = R.rows.map((r) => r.g).concat(R.a);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const useLog = min > 0 && max / min > 20;
  const tf = (v) => (useLog ? Math.log10(v) : v);
  let lo = tf(min);
  let hi = tf(max);
  if (hi - lo < 1e-12) {
    const w = useLog ? 0.5 : Math.max(1, Math.abs(hi) * 0.1);
    lo -= w;
    hi += w;
  }
  const pad = (hi - lo) * 0.06;
  lo -= pad;
  hi += pad;
  const pos = (v) => ((tf(v) - lo) / (hi - lo)) * 100;

  const dots = R.rows.map((r) => ({ r, x: pos(r.g) })).sort((a, b) => a.x - b.x);
  const lanes = [];
  for (const d of dots) {
    let lane = 0;
    while (lanes[lane] && lanes[lane].some((x) => Math.abs(x - d.x) < 7)) lane++;
    (lanes[lane] ||= []).push(d.x);
    d.lane = lane;
  }
  const height = 44 + lanes.length * 28;
  el.innerHTML = `
    <div class="nl-track" style="--nl-h:${height}px">
      <div class="nl-axis"></div>
      <div class="nl-answer" style="left:${pos(R.a).toFixed(2)}%"></div>
      ${dots.map((d) => {
        const p = findPlayer(d.r.id) || { name: '?', color: '#a8c1b5' };
        return `<div class="nl-dot" style="left:${d.x.toFixed(2)}%;bottom:${12 + d.lane * 28}px;background:${safeColor(p.color)}" title="${esc(p.name)}">${initial(p.name)}</div>`;
      }).join('')}
    </div>
    <div class="nl-scale"><span>${esc(fmt(min))}</span><span class="nl-note">amber line = answer${useLog ? ' · log scale' : ''}</span><span>${esc(fmt(max))}</span></div>`;
}

function renderFinal(m, isHost) {
  show('screen-final');
  const winners = (ST.winners || []).map(findPlayer).filter(Boolean);
  const top = winners[0]?.score ?? 0;
  const pts = `${top} point${top === 1 ? '' : 's'}`;
  const iWon = winners.some((w) => w.id === m.id);
  if (winners.length > 1) {
    $('#f-winner').textContent = "It's a tie!";
    $('#f-sub').textContent = `${winners.map((w) => w.name).join(' & ')} share the win with ${pts}.${iWon ? " That's you!" : ''}`;
  } else if (winners.length === 1) {
    $('#f-winner').textContent = `${winners[0].name} wins!`;
    $('#f-sub').textContent = `With ${pts}.${iWon ? " That's you!" : ''}`;
  } else {
    $('#f-winner').textContent = 'Game over';
    $('#f-sub').textContent = '';
  }
  $('#f-scores').innerHTML = scoreList(m);
  $('#f-host').hidden = !isHost;
  $('#f-guest').hidden = isHost;
}

function uiTick() {
  if (!ST) return;
  if (ST.phase === 'question') {
    const ms = remainingMs();
    const secs = Math.max(0, Math.ceil(ms / 1000));
    const timer = $('#q-timer');
    timer.textContent = secs;
    timer.classList.toggle('low', secs <= 5);
    const total = (ST.settings?.seconds || 30) * 1000;
    $('#q-bar').style.width = `${Math.max(0, Math.min(100, (ms / total) * 100))}%`;
    if (ms <= 0 && !$('#guess-form').hidden) { lastKey = ''; render(); }
  } else if (ST.phase === 'reveal') {
    const secs = Math.max(0, Math.ceil((ST.revealEnds - (Date.now() + skew)) / 1000));
    const last = ST.round >= ST.total;
    const text = `${last ? 'Final results' : 'Next round'} in ${secs}s`;
    const el = $('#r-next');
    if (el.textContent !== text) el.textContent = text;
  }
}

/* ------------------------------------------------------------------ *
 * Small UI helpers
 * ------------------------------------------------------------------ */

function showBusy(text, cancellable = false) {
  $('#busy-text').textContent = text;
  $('#busy-cancel').hidden = !cancellable;
  $('#busy').hidden = false;
}
function hideBusy() { $('#busy').hidden = true; }

function showError(msg) { $('#home-error').textContent = msg; }

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function setBanner(msg) {
  const el = $('#banner');
  el.hidden = !msg;
  if (msg && el.textContent !== msg) el.textContent = msg;
}

function setConn(stateName) {
  const el = $('#conn');
  el.classList.toggle('warn', stateName === 'warn');
  el.classList.toggle('bad', stateName === 'bad');
  el.setAttribute('aria-label', stateName === 'ok' ? 'Connected' : stateName === 'bad' ? 'Offline' : 'Reconnecting');
  el.title = el.getAttribute('aria-label');
}

function setPreview(msg, isError = false) {
  const el = $('#guess-preview');
  el.textContent = msg;
  el.style.color = isError ? 'var(--red)' : '';
}

function selectTab(which) {
  const join = which === 'join';
  $('#tab-join').setAttribute('aria-selected', String(join));
  $('#tab-host').setAttribute('aria-selected', String(!join));
  $('#pane-join').hidden = !join;
  $('#pane-host').hidden = join;
  showError('');
}

function showHome() {
  show('screen-home');
  $('#topbar').hidden = true;
  const saved = local.get('name');
  if (saved && !$('#name').value) $('#name').value = saved;
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock && role) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported or not allowed */ }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* already released */ }
  wakeLock = null;
}

function readName() {
  const name = cleanName($('#name').value);
  if (!name) {
    showError('Enter your name first.');
    $('#name').focus();
    return null;
  }
  return name;
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function wire() {
  for (const slot of $$('.rules-slot')) slot.appendChild($('#rules-tpl').content.cloneNode(true));

  $('#tab-join').addEventListener('click', () => selectTab('join'));
  $('#tab-host').addEventListener('click', () => selectTab('host'));

  $('#code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });

  $('#pane-join').addEventListener('submit', (e) => {
    e.preventDefault();
    showError('');
    const name = readName();
    if (!name) return;
    const code = $('#code').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { showError('Room codes are 4 letters, like ABCD.'); $('#code').focus(); return; }
    const params = new URLSearchParams(location.search);
    const hintRaw = params.get('room')?.toUpperCase() === code ? params.get('b') : null;
    joinRoom(code, name, hintRaw === null ? null : Number(hintRaw));
  });

  $('#btn-host').addEventListener('click', () => {
    showError('');
    const name = readName();
    if (name) createRoom(name);
  });

  $('#busy-cancel').addEventListener('click', () => {
    joinAttempt = null;
    if (role === 'player') send('leave');
    leaveLocal();
    showHome();
  });

  $('#btn-share').addEventListener('click', async () => {
    const url = inviteUrl();
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Ballpark', text: `Join my Ballpark game! Room code ${ST.code}`, url });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied');
    } catch {
      toast('Copy the link shown below');
    }
  });

  for (const b of $$('#set-rounds button')) b.addEventListener('click', () => hostSet('rounds', Number(b.dataset.v)));
  for (const b of $$('#set-seconds button')) b.addEventListener('click', () => hostSet('seconds', Number(b.dataset.v)));
  $('#btn-start').addEventListener('click', () => startGame());
  $('#btn-reveal-now').addEventListener('click', () => { if (H?.phase === 'question') doReveal(); });
  $('#btn-next').addEventListener('click', () => advance());
  $('#btn-again').addEventListener('click', () => playAgain());
  $('#btn-close').addEventListener('click', () => {
    if (confirm('Close this room for everyone?')) closeRoom();
  });

  $('#guess').addEventListener('input', () => {
    const raw = $('#guess').value;
    const v = parseGuess(raw);
    if (v === null) setPreview('');
    else if (Number.isNaN(v)) setPreview('Numbers only, like 1500 or 1.3 million.', true);
    else if (fmt(v) !== raw.trim()) setPreview(`= ${withUnit(v, ST?.q?.u)}`);
    else setPreview('');
  });

  // Phone number pads have no letters, so these add the word for you.
  for (const b of $$('.mult button')) {
    b.addEventListener('click', () => {
      const input = $('#guess');
      const base = input.value.replace(/\s*(k|thousand|mil|mn|million|b|bn|billion|trillion)\s*$/i, '').trim() || '1';
      input.value = `${base} ${b.dataset.word}`;
      input.dispatchEvent(new Event('input'));
    });
  }

  $('#guess-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!ST || ST.phase !== 'question') return;
    const v = parseGuess($('#guess').value);
    if (v === null) { setPreview('Type a number first.', true); return; }
    if (Number.isNaN(v)) { setPreview("That doesn't look like a number. Try 1500, or 1.3 then tap million.", true); return; }
    if (Math.abs(v) > 1e15) { setPreview("That's too big. Try a smaller number.", true); return; }
    if (remainingMs() <= 0) return;
    myGuess = { round: ST.round, dl: ST.deadline, value: v };
    session.set('guess', { code: ST.code, ...myGuess });
    $('#guess').blur();
    send('guess', { round: ST.round, value: v });
    lastKey = '';
    render();
  });

  $('#tb-rules').addEventListener('click', () => $('#rules-dialog').showModal());
  $('#tb-leave').addEventListener('click', () => {
    if (role === 'host') {
      if (confirm('Leave and close this room for everyone?')) closeRoom();
      return;
    }
    if (!confirm('Leave this game?')) return;
    send('leave');
    const client = net?.client;
    leaveLocal({ keepClient: true });
    setTimeout(() => { try { client?.end(false); } catch { /* already closed */ } }, 400);
    showHome();
  });
  $('#btn-msg-home').addEventListener('click', () => showHome());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (role === 'host') { hostTick(); publishState(); }
    if (role === 'player') playerTick();
    requestWakeLock();
  });
}

function init() {
  wire();
  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  const urlHint = params.get('b') === null ? null : Number(params.get('b'));
  const saved = session.get('room');

  if (saved && saved.code && (!urlRoom || urlRoom === saved.code)) {
    const hostSave = session.get('host');
    if (saved.role === 'host' && hostSave && hostSave.code === saved.code) { resumeHost(hostSave); return; }
    if (saved.role === 'player') { joinRoom(saved.code, saved.name, saved.broker, { resume: true }); return; }
  }
  showHome();
  if (urlRoom.length === 4) {
    selectTab('join');
    $('#code').value = urlRoom;
    if (!$('#name').value) $('#name').focus();
  } else if (urlHint !== null) {
    history.replaceState(null, '', location.pathname);
  }
}

// Read-only hooks used by the automated browser tests.
window.__ballpark = { state: () => ST, host: () => H, role: () => role };

init();
