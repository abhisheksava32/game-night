/* ------------------------------------------------------------------ *
 * Room kit: online rooms for turn-based games, joined by a 4-letter code.
 *
 * There is no game server. Devices exchange JSON through public MQTT relays.
 * The host's browser owns the game: players send actions, the host checks
 * them with the game's own rules (onAction) and publishes one shared state
 * that every screen renders.
 *
 * A game supplies:
 *   game          short id, used to keep each game's rooms apart
 *   minPlayers    fewest seated players needed to start
 *   maxPlayers    most seated players; later arrivals watch as spectators
 *   init(seats, settings)          -> game state   (seats: [{seat, name, color}])
 *   onAction(game, seat, action)   -> { game } or { error: 'message' }
 *   onLeave(game, seat)            -> game state   (a seated player left for good)
 *   onUpdate(room)                 -> called on every change (see roomView below)
 *
 * Game state must be plain JSON. onAction and onLeave must not mutate their
 * input: return a new object.
 * ------------------------------------------------------------------ */

export const RELAYS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081',
];
const NS = 'game-night/v1';
const AWAY_MS = 15000;
const HEARTBEAT_MS = 3000;
const RESEND_MS = 1500;
const PING_MS = 5000;
const HOST_SILENT_MS = 12000;
const STALE_ROOM_MS = 10 * 60 * 1000;
const MAX_ACT_BYTES = 4096;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const COLORS = ['#ffc93c', '#5ec8f2', '#ff7ab6', '#7be495', '#ff9a52', '#b99bff', '#ff6b5e', '#4fd1c5'];

function rid(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}
function randInt(n) {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
}
const clone = (x) => JSON.parse(JSON.stringify(x));

function store(area, prefix) {
  const key = (k) => `${prefix}:${k}`;
  return {
    get(k) { try { return JSON.parse(area.getItem(key(k))); } catch { return null; } },
    set(k, v) { try { area.setItem(key(k), JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k) { try { area.removeItem(key(k)); } catch { /* storage unavailable */ } },
  };
}

export function cleanName(raw) {
  return String(typeof raw === 'string' ? raw : '')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 16);
}

function connectRelay(idx, ms = 7000) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(RELAYS[idx], {
      clientId: `gn_${rid(10)}`, keepalive: 20, reconnectPeriod: 2000,
      connectTimeout: ms, clean: true, resubscribe: true,
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
    client.on('error', () => { /* the client retries; the timeout decides when to give up */ });
  });
}

export function createRoom(cfg) {
  const G = cfg.game;
  const T = (code, kind) => `${NS}/${G}/${code}/${kind}`;
  const session = store(sessionStorage, `gn:${G}`);
  const local = store(localStorage, `gn:${G}`);

  let role = null;   // 'host' | 'player' | null
  let net = null;    // { client, relay, code }
  let ST = null;     // latest shared state
  let H = null;      // host only: full room including secrets
  let skew = 0;
  let lastLive = 0;
  let myName = '';
  let loops = [];
  let lastPing = 0;
  let lastPublish = 0;
  let publishQueued = false;
  let lastTickAt = 0;
  let deafUntil = 0;
  let pending = null; // { n, action } waiting for the host to confirm
  let nextN = 1;
  let connState = 'ok';
  let joinAttempt = null;

  function me() {
    let m = session.get('me');
    if (!m || !m.id || !m.secret) {
      m = { id: rid(10), secret: rid(16) };
      session.set('me', m);
    }
    return m;
  }

  /* ---------------- networking ---------------- */

  function attach(client, relay, code) {
    net = { client, relay, code };
    client.on('message', onMessage);
    client.on('connect', () => {
      connState = 'ok';
      if (role === 'host') publishState();
      if (role === 'player') playerTick();
      emit();
    });
    client.on('reconnect', () => { connState = 'warn'; emit(); });
    client.on('close', () => { connState = 'warn'; emit(); });
    client.on('offline', () => { connState = 'bad'; emit(); });
    connState = client.connected ? 'ok' : 'warn';
  }

  function onMessage(topic, payload, packet) {
    if (!net || !payload || !payload.length) return;
    const isAct = topic === T(net.code, 'act');
    if (isAct && payload.length > MAX_ACT_BYTES) return;
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch { return; }
    try {
      if (role === 'player' && topic === T(net.code, 'state')) applyState(msg, packet.retain);
      else if (role === 'host' && isAct) hostHandle(msg);
    } catch (err) {
      console.warn('Ignored a bad message', err);
    }
  }

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
        connectRelay(idx, ms).then((client) => {
          if (done) { client.end(true); return; }
          const onMsg = (t, p, packet) => {
            if (t !== topic || !p || !p.length) return;
            let s;
            try { s = JSON.parse(p.toString()); } catch { return; }
            if (!s || s.code !== code || typeof s.now !== 'number') return;
            if (packet.retain && Date.now() - s.now > STALE_ROOM_MS) return;
            const hit = { client, idx, state: s, live: !packet.retain };
            if (hit.live) finish(hit);
            else if (!best || s.now > best.state.now) best = hit;
          };
          open.push({ client, onMsg });
          client.on('message', onMsg);
          client.subscribe(topic);
        }).catch(() => { /* unreachable relay */ });
      }
    });
  }

  async function findRoom(code, hint) {
    const valid = Number.isInteger(hint) && hint >= 0 && hint < RELAYS.length;
    if (valid) {
      const hit = await probeRelays([hint], code, 4500);
      if (hit) return hit;
    }
    return probeRelays(RELAYS.map((_, i) => i).filter((i) => !valid || i !== hint), code, 6500);
  }

  function send(type, data = {}) {
    const m = me();
    const msg = { t: type, pid: m.id, sec: m.secret, ...data };
    if (role === 'host') { hostHandle(msg); return; }
    if (net?.client) net.client.publish(T(net.code, 'act'), JSON.stringify(msg), { qos: 0 });
  }

  /* ---------------- host ---------------- */

  function makeCode() {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_LETTERS[randInt(CODE_LETTERS.length)];
    return c;
  }
  const seated = () => H.players.filter((p) => !p.left);

  function uniqueName(name, id) {
    const base = name || 'Player';
    let n = base;
    let k = 2;
    while (H.players.some((p) => p.id !== id && !p.left && p.name.toLowerCase() === n.toLowerCase())) {
      n = `${base.slice(0, 13)} ${k++}`;
    }
    return n;
  }
  function nextColor() {
    const used = new Set(seated().map((p) => p.color));
    return COLORS.find((c) => !used.has(c)) || COLORS[H.players.length % COLORS.length];
  }

  function hostHandle(a) {
    if (!H || !a || typeof a !== 'object') return;
    if (typeof a.pid !== 'string' || !/^[0-9a-z]{10}$/.test(a.pid)) return;
    if (typeof a.sec !== 'string' || !/^[0-9a-z]{16}$/.test(a.sec)) return;
    const now = Date.now();
    const p = H.players.find((x) => x.id === a.pid);

    if (a.t === 'join') {
      if (H.phase === 'closed') return;
      if (p) {
        if (p.secret !== a.sec) return;
        p.lastSeen = now;
        if (p.away || p.left) {
          p.away = false;
          // Someone who left for good comes back as a spectator.
          if (p.left) { p.left = false; p.seat = H.phase === 'playing' ? null : p.seat; }
          changed();
        }
        return;
      }
      const maxRoom = Math.max(cfg.maxPlayers, 8) + 4; // seats plus a few spectators
      if (seated().length >= maxRoom) {
        if (!Object.hasOwn(H.rejected, a.pid) && Object.keys(H.rejected).length < 16) { H.rejected[a.pid] = now; changed(); }
        return;
      }
      H.players = H.players.filter((x) => !x.left || x.seat !== null);
      H.players.push({
        id: a.pid, secret: a.sec, name: uniqueName(cleanName(a.name), a.pid), color: nextColor(),
        seat: null, lastSeen: now, away: false, left: false, lastN: 0,
      });
      changed();
      return;
    }

    if (!p || p.secret !== a.sec) return;
    p.lastSeen = now;
    if (a.t !== 'leave' && p.away) { p.away = false; changed(); }

    if (a.t === 'act') {
      const n = a.n;
      if (!Number.isInteger(n) || n <= p.lastN) return; // already handled
      p.lastN = n;
      if (H.phase !== 'playing' || p.seat === null || !H.game) {
        H.errors[p.id] = { n, msg: H.phase !== 'playing' ? 'The game has not started.' : 'You are watching this game.' };
      } else {
        let res;
        try { res = cfg.onAction(clone(H.game), p.seat, a.action); } catch (err) { res = { error: 'That move is not allowed.' }; console.warn(err); }
        if (res && res.game) { H.game = res.game; delete H.errors[p.id]; }
        else H.errors[p.id] = { n, msg: (res && res.error) || 'That move is not allowed.' };
      }
      changed();
    } else if (a.t === 'leave') {
      if (p.id === H.hostId) return;
      if (H.phase === 'lobby' || p.seat === null) {
        H.players = H.players.filter((x) => x !== p);
      } else {
        p.left = true;
        p.away = true;
        if (cfg.onLeave && H.game) {
          try { H.game = cfg.onLeave(clone(H.game), p.seat); } catch (err) { console.warn(err); }
        }
      }
      changed();
    }
  }

  function hostTick() {
    if (!H || role !== 'host') return;
    const now = Date.now();
    // After this page was asleep, offline or reloaded, players could not reach us.
    // Give them time to re-send before marking anyone away.
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
    if (dirty) changed();
    else if (now - lastPublish >= HEARTBEAT_MS) publishState();
  }

  function publicState() {
    return {
      v: 1,
      code: H.code,
      host: H.hostId,
      b: H.relay,
      phase: H.phase,
      settings: H.settings,
      players: H.players.filter((p) => !p.left || p.seat !== null).map((p) => ({
        id: p.id, name: p.name, color: p.color, seat: p.seat, away: !!p.away, left: !!p.left, lastN: p.lastN,
      })),
      game: H.game,
      errors: H.errors,
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

  /* ---------------- player ---------------- */

  function applyState(s, retained) {
    if (!s || typeof s !== 'object' || !net || s.code !== net.code) return;
    if (!Array.isArray(s.players) || typeof s.seq !== 'number' || typeof s.phase !== 'string'
      || typeof s.host !== 'string' || typeof s.now !== 'number') return;
    if (ST && s.host === ST.host && s.seq < ST.seq) return;
    if (!retained) { skew = s.now - Date.now(); lastLive = Date.now(); }
    const prev = ST;
    ST = s;
    const mine = s.players.find((p) => p.id === me().id);
    if (mine && pending && mine.lastN >= pending.n) {
      const err = s.errors && s.errors[mine.id];
      pending = null;
      if (err && err.n === mine.lastN && cfg.onError) cfg.onError(err.msg);
    }
    emit(prev);
  }

  function playerTick() {
    if (role !== 'player' || !ST) return;
    const m = me();
    const now = Date.now();
    const mine = ST.players.find((p) => p.id === m.id);
    if (!mine) {
      if (!(ST.rejected && ST.rejected[m.id])) send('join', { name: myName });
    } else if (pending) {
      send('act', { n: pending.n, action: pending.action });
    }
    if (now - lastPing >= PING_MS) { lastPing = now; send('ping'); }
    emit();
  }

  /* ---------------- rooms ---------------- */

  function enter(code, relay, r, name) {
    session.set('room', { code, relay, role: r, name });
    local.set('name', name);
    history.replaceState(null, '', `${location.pathname}?room=${code}&b=${relay}`);
    lastLive = Date.now();
    loops.push(r === 'host' ? setInterval(hostTick, 250) : setInterval(playerTick, RESEND_MS));
  }

  function reset() {
    loops.forEach(clearInterval);
    loops = [];
    const client = net?.client;
    net = null;
    role = null; ST = null; H = null; pending = null;
    lastTickAt = 0; deafUntil = 0;
    session.del('room');
    session.del('host');
    history.replaceState(null, '', location.pathname);
    return client;
  }

  async function host(name, settings = {}) {
    let client = null;
    let relay = -1;
    for (let i = 0; i < RELAYS.length && !client; i++) {
      try { client = await connectRelay(i, 6000); relay = i; } catch { /* next relay */ }
    }
    if (!client) throw new Error("Couldn't reach the game server. Check your internet connection and try again.");
    let code = makeCode();
    for (let tries = 0; tries < 4 && (await codeTaken(client, code)); tries++) code = makeCode();
    const m = me();
    H = {
      code, relay, hostId: m.id, seq: 0, phase: 'lobby', settings: { ...settings },
      players: [{ id: m.id, secret: m.secret, name: cleanName(name) || 'Host', color: COLORS[0], seat: null, lastSeen: Date.now(), away: false, left: false, lastN: 0 }],
      game: null, errors: {}, rejected: {},
    };
    role = 'host';
    myName = name;
    attach(client, relay, code);
    client.subscribe(T(code, 'act'), { qos: 0 });
    enter(code, relay, 'host', name);
    publishState();
    return code;
  }

  async function join(code, name, hint) {
    const attempt = {};
    joinAttempt = attempt;
    const found = await findRoom(code, hint);
    if (joinAttempt !== attempt) { found?.client.end(true); throw new Error('cancelled'); }
    joinAttempt = null;
    if (!found) throw new Error(`No game found with code ${code}. Check the code with your host.`);
    if (found.state.phase === 'closed') { found.client.end(true); throw new Error(`Room ${code} has closed.`); }

    let cur = session.get('me');
    if (cur && cur.id === found.state.host && !session.get('host')) { session.del('me'); cur = null; }
    const kept = local.get(`me:${code}`);
    const curSeated = !!cur && found.state.players.some((p) => p.id === cur.id);
    if (kept?.id && kept?.secret && kept.id !== found.state.host && !curSeated) session.set('me', kept);
    local.set(`me:${code}`, me());

    role = 'player';
    myName = name;
    attach(found.client, found.idx, code);
    found.client.subscribe(T(code, 'state'), { qos: 0 });
    enter(code, found.idx, 'player', name);
    const mine = found.state.players.find((p) => p.id === me().id);
    nextN = Math.max(nextN, (mine?.lastN || 0) + 1);
    applyState(found.state, !found.live);
    send('join', { name });
    return code;
  }

  async function resumeHost(saved, onWaiting) {
    const stillWanted = () => session.get('host')?.code === saved.code;
    let client = null;
    while (!client) {
      try { client = await connectRelay(saved.relay, 8000); } catch {
        if (!stillWanted()) return false;
        if (onWaiting) onWaiting();
      }
    }
    if (!stillWanted()) { client.end(true); return false; }
    H = saved;
    role = 'host';
    myName = H.players.find((p) => p.id === H.hostId)?.name || '';
    attach(client, H.relay, H.code);
    client.subscribe(T(H.code, 'act'), { qos: 0 });
    enter(H.code, H.relay, 'host', myName);
    publishState();
    return true;
  }

  /** Rejoin a room this tab was in before a refresh. Returns a promise, or null if there is nothing to resume. */
  function resume(onWaiting) {
    const saved = session.get('room');
    if (!saved || !saved.code) return null;
    const params = new URLSearchParams(location.search);
    const urlRoom = (params.get('room') || '').toUpperCase();
    if (urlRoom && urlRoom !== saved.code) return null;
    const hostSave = session.get('host');
    if (saved.role === 'host' && hostSave && hostSave.code === saved.code) return resumeHost(hostSave, onWaiting);
    if (saved.role === 'player') return join(saved.code, saved.name, saved.relay).then(() => true);
    return null;
  }

  function start() {
    if (!H || H.phase !== 'lobby') return 'Only the host can start.';
    const ready = H.players.filter((p) => !p.left && (!p.away || p.id === H.hostId));
    if (ready.length < cfg.minPlayers) return `You need at least ${cfg.minPlayers} players to start.`;
    const seats = ready.slice(0, cfg.maxPlayers);
    H.players.forEach((p) => { p.seat = null; });
    seats.forEach((p, i) => { p.seat = i; });
    H.players = H.players.filter((p) => !p.left);
    H.game = cfg.init(seats.map((p) => ({ seat: p.seat, name: p.name, color: p.color })), clone(H.settings));
    H.errors = {};
    H.phase = 'playing';
    changed();
    return null;
  }

  function backToLobby() {
    if (!H || H.phase !== 'playing') return;
    H.players = H.players.filter((p) => !p.left);
    H.players.forEach((p) => { p.seat = null; });
    H.game = null;
    H.errors = {};
    H.phase = 'lobby';
    changed();
  }

  function setSettings(patch) {
    if (!H || H.phase !== 'lobby') return;
    H.settings = { ...H.settings, ...patch };
    changed();
  }

  function act(action) {
    if (!ST) return;
    const mine = ST.players.find((p) => p.id === me().id);
    const n = Math.max(nextN, (mine?.lastN || 0) + 1);
    nextN = n + 1;
    pending = { n, action };
    send('act', { n, action });
  }

  function leave() {
    if (role === 'host' && H && net?.client) {
      H.phase = 'closed';
      net.client.publish(T(H.code, 'state'), JSON.stringify(publicState()), { qos: 1, retain: true });
    } else if (role === 'player') {
      send('leave');
    }
    const client = reset();
    setTimeout(() => { try { client?.end(false); } catch { /* already closed */ } }, 800);
  }

  function cancelJoin() {
    joinAttempt = null;
    const client = reset();
    try { client?.end(true); } catch { /* already closed */ }
  }

  function roomView() {
    if (!ST) return null;
    const m = me();
    const mine = ST.players.find((p) => p.id === m.id) || null;
    return {
      ...ST,
      me: {
        id: m.id,
        seat: mine ? mine.seat : null,
        joined: !!mine,
        isHost: ST.host === m.id,
        rejected: !mine && !!(ST.rejected && ST.rejected[m.id]),
      },
      connection: connState,
      hostSilent: role === 'player' && Date.now() - lastLive > HOST_SILENT_MS,
      waiting: !!pending,
      skew,
    };
  }

  function emit() {
    if (cfg.onUpdate) cfg.onUpdate(roomView());
  }

  function inviteUrl() {
    return `${location.origin}${location.pathname}?room=${ST?.code || ''}&b=${net?.relay ?? 0}`;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (role === 'host') { hostTick(); publishState(); }
    if (role === 'player') playerTick();
  });

  return {
    host, join, resume, start, backToLobby, setSettings, act, leave, cancelJoin, inviteUrl,
    get view() { return roomView(); },
    get role() { return role; },
    savedName: () => local.get('name') || '',
    maxPlayers: cfg.maxPlayers,
    minPlayers: cfg.minPlayers,
  };
}
