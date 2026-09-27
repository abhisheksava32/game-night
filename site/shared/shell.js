/* ------------------------------------------------------------------ *
 * Shell: the page frame every Game Night game uses.
 *
 * mountShell({
 *   id, title: ['TIC TAC', 'TOE'], tagline, rulesHtml,
 *   online: {                       // optional: room-code multiplayer
 *     minPlayers, maxPlayers,
 *     settings: [{ key, label, options: [{ value, label }], default }],
 *     init, onAction, onLeave,      // see room.js
 *     render(root, ctx),            // draw the game; called on every update
 *   },
 *   local: [{ id, label, hint }],   // optional: modes played on this device
 *   startLocal(root, modeId, ctx),  // start a local mode; return a cleanup function
 * })
 *
 * Online ctx: { view, act(action), isHost, mySeat, rematch(), toLobby(), toast(msg) }
 * Local ctx:  { exit(), toast(msg), name }
 * ------------------------------------------------------------------ */
import { createRoom, cleanName } from './room.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#a4a9c6');
export const initial = (name) => esc((Array.from(String(name || '?').trim())[0] || '?').toUpperCase());
export const avatar = (p) => `<span class="avatar" style="background:${safeColor(p?.color)}">${initial(p?.name)}</span>`;

let toastTimer = null;
export function toast(msg) {
  const el = document.getElementById('gn-toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

export function mountShell(cfg) {
  const online = cfg.online || null;
  const localModes = cfg.local || [];
  const $ = (sel) => document.querySelector(sel);

  document.body.insertAdjacentHTML('afterbegin', `
    <header class="topbar">
      <a class="back" href="../../" aria-label="All games">&#x2190; Games</a>
      <span class="brand">${esc(cfg.title[0])}<span>${esc(cfg.title[1] || '')}</span></span>
      <span class="spacer"></span>
      <span id="gn-room" class="chip" hidden>Room <b id="gn-code">----</b></span>
      <span id="gn-dot" class="dot" hidden role="status" aria-label="Connected"></span>
      <button id="gn-rules-btn" class="icon-btn" type="button" aria-label="How to play">?</button>
      <button id="gn-leave" class="icon-btn" type="button" aria-label="Leave" hidden>&#x2715;</button>
    </header>
    <div id="gn-banner" class="banner" role="status" hidden></div>
    <main class="wrap">
      <section id="gn-home" class="screen">
        <div class="center" style="padding-top:20px">
          <p class="kicker">Game Night</p>
          <h1 class="title">${esc(cfg.title[0])}<span>${esc(cfg.title[1] || '')}</span></h1>
          <p class="lede">${esc(cfg.tagline)}</p>
        </div>
        <div class="card stack" id="gn-entry">
          ${online ? `
          <div>
            <label for="gn-name">Your name</label>
            <input id="gn-name" maxlength="16" autocomplete="nickname" placeholder="e.g. Sam">
          </div>
          <div class="tabs" role="tablist" aria-label="Join or host">
            <button type="button" role="tab" id="gn-tab-join" aria-selected="true">Join a game</button>
            <button type="button" role="tab" id="gn-tab-host" aria-selected="false">Host a game</button>
          </div>
          <form id="gn-join" class="stack" style="gap:10px">
            <label for="gn-code-in" style="margin:0">Room code</label>
            <input id="gn-code-in" class="code-input" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD">
            <button class="btn primary" type="submit">Join game</button>
          </form>
          <div id="gn-host" class="stack" style="gap:10px" hidden>
            <p class="hint">You'll get a 4-letter room code to share with ${online.maxPlayers === 2 ? 'your opponent' : 'friends'}.</p>
            <button id="gn-host-btn" class="btn primary" type="button">Create a room</button>
          </div>` : ''}
          ${localModes.length ? `
          <div class="stack" style="gap:10px">
            ${online ? '<p class="label" style="margin-top:6px">Or play on this device</p>' : ''}
            ${localModes.map((m) => `
              <button class="btn ${online ? 'ghost' : 'primary big'}" type="button" data-local="${esc(m.id)}">${esc(m.label)}</button>
              ${m.hint ? `<p class="hint small center" style="margin-top:-4px">${esc(m.hint)}</p>` : ''}`).join('')}
          </div>` : ''}
          <p id="gn-error" class="error" role="alert"></p>
        </div>
        <section class="card rules">${cfg.rulesHtml}</section>
        ${cfg.homeExtraHtml || ''}
      </section>

      <section id="gn-lobby" class="screen" hidden>
        <div class="board-card">
          <p class="kicker">Room code</p>
          <div id="gn-lobby-code" class="led big">----</div>
          <button id="gn-share" class="btn ghost" type="button" style="max-width:320px;margin:0 auto 8px">Share invite link</button>
          <p id="gn-share-url" class="hint small" style="word-break:break-all"></p>
        </div>
        <div class="card">
          <h2 class="h">Players <span id="gn-count" class="pill"></span></h2>
          <ul id="gn-players" class="players"></ul>
          <p id="gn-seat-note" class="hint small" style="margin-top:10px"></p>
        </div>
        <div id="gn-host-panel" class="card" hidden>
          <div id="gn-settings"></div>
          <button id="gn-start" class="btn primary big" type="button">Start game</button>
          <p id="gn-start-hint" class="hint center" style="margin-top:10px"></p>
        </div>
        <div id="gn-guest-wait" class="card waiting" hidden>
          <div class="pulse" aria-hidden="true"></div>
          <p>Waiting for <b id="gn-host-name">the host</b> to start&hellip;</p>
          <p id="gn-guest-settings" class="hint small"></p>
        </div>
      </section>

      <section id="gn-play" class="screen" hidden><div id="gn-game"></div></section>

      <section id="gn-msg" class="screen" hidden>
        <div class="card center stack" style="margin-top:40px">
          <h2 id="gn-msg-title" style="margin:0"></h2>
          <p id="gn-msg-body" style="margin:0"></p>
          <button id="gn-msg-home" class="btn primary" type="button">Back</button>
        </div>
      </section>
    </main>
    <div id="gn-busy" class="busy" hidden>
      <div class="spinner" aria-hidden="true"></div>
      <p id="gn-busy-text" style="margin:0">Connecting&hellip;</p>
      <button id="gn-busy-cancel" class="btn ghost small" type="button" style="width:auto" hidden>Cancel</button>
    </div>
    <div id="gn-toast" class="toast" role="status" hidden></div>
    <dialog id="gn-rules" aria-label="How to play">
      <div class="rules">${cfg.rulesHtml}</div>
      <form method="dialog"><button class="btn primary" type="submit">Got it</button></form>
    </dialog>`);

  let curScreen = null;
  let localCleanup = null;
  let lastRenderKey = '';

  function show(id) {
    for (const s of document.querySelectorAll('main > .screen')) s.hidden = s.id !== id;
    if (id !== curScreen) { curScreen = id; window.scrollTo(0, 0); }
  }
  const showBusy = (text, cancellable = false) => {
    $('#gn-busy-text').textContent = text;
    $('#gn-busy-cancel').hidden = !cancellable;
    $('#gn-busy').hidden = false;
  };
  const hideBusy = () => { $('#gn-busy').hidden = true; };
  const showError = (msg) => { const e = $('#gn-error'); if (e) e.textContent = msg; };
  const setBanner = (msg) => {
    const el = $('#gn-banner');
    el.hidden = !msg;
    if (msg && el.textContent !== msg) el.textContent = msg;
  };
  function showMsg(title, body) {
    $('#gn-msg-title').textContent = title;
    $('#gn-msg-body').textContent = body;
    setOnlineChrome(false);
    show('gn-msg');
  }
  function setOnlineChrome(on) {
    $('#gn-room').hidden = !on;
    $('#gn-dot').hidden = !on;
    $('#gn-leave').hidden = !on && !localCleanup;
    if (!on) setBanner(null);
  }
  function goHome() {
    if (localCleanup) { try { localCleanup(); } catch (err) { console.warn(err); } localCleanup = null; }
    $('#gn-game').innerHTML = '';
    setOnlineChrome(false);
    show('gn-home');
  }

  $('#gn-rules-btn').addEventListener('click', () => $('#gn-rules').showModal());
  $('#gn-msg-home').addEventListener('click', goHome);

  /* ---------------- local modes ---------------- */
  for (const b of document.querySelectorAll('[data-local]')) {
    b.addEventListener('click', () => {
      showError('');
      const root = $('#gn-game');
      root.innerHTML = '';
      show('gn-play');
      const name = online ? cleanName($('#gn-name').value) : '';
      localCleanup = cfg.startLocal(root, b.dataset.local, {
        exit: goHome,
        toast,
        name,
      }) || (() => {});
      $('#gn-leave').hidden = false;
    });
  }

  if (!online) {
    $('#gn-leave').addEventListener('click', goHome);
    show('gn-home');
    return { toast };
  }

  /* ---------------- online ---------------- */
  const settingsDefaults = Object.fromEntries((online.settings || []).map((s) => [s.key, s.default]));
  const room = createRoom({
    game: cfg.id,
    minPlayers: online.minPlayers,
    maxPlayers: online.maxPlayers,
    init: online.init,
    onAction: online.onAction,
    onLeave: online.onLeave,
    onUpdate: (view) => render(view),
    onError: (msg) => toast(msg),
  });

  const readName = () => {
    const name = cleanName($('#gn-name').value);
    if (!name) { showError('Enter your name first.'); $('#gn-name').focus(); return null; }
    return name;
  };
  const selectTab = (which) => {
    const join = which === 'join';
    $('#gn-tab-join').setAttribute('aria-selected', String(join));
    $('#gn-tab-host').setAttribute('aria-selected', String(!join));
    $('#gn-join').hidden = !join;
    $('#gn-host').hidden = join;
    showError('');
  };
  $('#gn-tab-join').addEventListener('click', () => selectTab('join'));
  $('#gn-tab-host').addEventListener('click', () => selectTab('host'));
  $('#gn-code-in').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
  $('#gn-name').value = room.savedName();

  $('#gn-join').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const name = readName();
    if (!name) return;
    const code = $('#gn-code-in').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { showError('Room codes are 4 letters, like ABCD.'); return; }
    const params = new URLSearchParams(location.search);
    const hintRaw = (params.get('room') || '').toUpperCase() === code ? params.get('b') : null;
    showBusy(`Looking for room ${code}…`, true);
    try {
      await room.join(code, name, hintRaw === null ? null : Number(hintRaw));
    } catch (err) {
      hideBusy();
      if (err.message !== 'cancelled') showError(err.message);
    }
  });

  $('#gn-host-btn').addEventListener('click', async () => {
    showError('');
    const name = readName();
    if (!name) return;
    showBusy('Creating your room…');
    try {
      await room.host(name, settingsDefaults);
      hideBusy();
    } catch (err) {
      hideBusy();
      showError(err.message);
    }
  });

  $('#gn-busy-cancel').addEventListener('click', () => {
    room.cancelJoin();
    hideBusy();
    goHome();
  });

  $('#gn-leave').addEventListener('click', () => {
    if (localCleanup) { goHome(); return; }
    if (room.role === 'host' && !confirm('Leave and close this room for everyone?')) return;
    if (room.role === 'player' && !confirm('Leave this game?')) return;
    room.leave();
    goHome();
  });

  $('#gn-share').addEventListener('click', async () => {
    const url = room.inviteUrl();
    if (navigator.share) {
      try { await navigator.share({ title: cfg.title.join(' '), text: `Join my ${cfg.title.join(' ')} game! Room code ${room.view?.code}`, url }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('Invite link copied'); } catch { toast('Copy the link shown below'); }
  });

  $('#gn-start').addEventListener('click', () => {
    const err = room.start();
    if (err) toast(err);
  });

  $('#gn-settings').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-key]');
    if (!b) return;
    const setting = online.settings.find((s) => s.key === b.dataset.key);
    const opt = setting && setting.options.find((o) => String(o.value) === b.dataset.value);
    if (opt) room.setSettings({ [setting.key]: opt.value });
  });

  const ctx = {
    get view() { return room.view; },
    act: (action) => room.act(action),
    get isHost() { return room.view?.me.isHost; },
    get mySeat() { return room.view?.me.seat; },
    rematch: () => { room.backToLobby(); const err = room.start(); if (err) toast(err); },
    toLobby: () => room.backToLobby(),
    toast,
  };

  function render(v) {
    if (!v) return;
    if (localCleanup) return;
    $('#gn-code').textContent = v.code;
    const dot = $('#gn-dot');
    dot.classList.toggle('warn', v.connection === 'warn');
    dot.classList.toggle('bad', v.connection === 'bad');
    setBanner(v.hostSilent ? "Can't reach the host right now. Waiting for them to reconnect…" : null);

    if (v.phase === 'closed') {
      if (!v.me.isHost) { room.leave(); showMsg('Room closed', 'The host closed this room. Thanks for playing!'); }
      return;
    }
    if (v.me.rejected) { room.leave(); showMsg('Room is full', `Room ${v.code} is full. Ask the host to start a new room.`); return; }
    setOnlineChrome(true);
    if (!v.me.joined) {
      showBusy(v.hostSilent ? `Room ${v.code} isn't answering. The host may have left, or their phone may be asleep.` : `Joining room ${v.code}…`, true);
      return;
    }
    hideBusy();

    if (v.phase === 'lobby') { lastRenderKey = ''; renderLobby(v); return; }
    show('gn-play');
    const key = JSON.stringify([v.seq > 0 ? v.game : null, v.players, v.me, v.waiting]);
    if (key === lastRenderKey) return;
    lastRenderKey = key;
    online.render($('#gn-game'), ctx);
  }

  function renderLobby(v) {
    show('gn-lobby');
    $('#gn-lobby-code').textContent = v.code;
    $('#gn-share-url').textContent = room.inviteUrl();
    const present = v.players.filter((p) => !p.left);
    $('#gn-count').textContent = `${present.length}`;
    const items = present.map((p, i) => `
      <li>
        ${avatar(p)}
        <span class="name">${esc(p.name)}</span>
        ${p.id === v.host ? '<span class="tag host">Host</span>' : ''}
        ${p.id === v.me.id ? '<span class="tag">You</span>' : ''}
        ${p.away ? '<span class="tag away">Away</span>' : ''}
        ${i >= online.maxPlayers ? '<span class="tag">Watching</span>' : ''}
      </li>`);
    if (present.length < online.minPlayers) items.push('<li class="empty">Waiting for players to join…</li>');
    $('#gn-players').innerHTML = items.join('');
    $('#gn-seat-note').textContent = online.maxPlayers === online.minPlayers
      ? `${online.maxPlayers} players. Anyone else who joins can watch.`
      : `${online.minPlayers} to ${online.maxPlayers} players. Anyone else who joins can watch.`;

    const isHost = v.me.isHost;
    $('#gn-host-panel').hidden = !isHost;
    $('#gn-guest-wait').hidden = isHost;
    const summary = (online.settings || []).map((s) => {
      const opt = s.options.find((o) => o.value === v.settings?.[s.key]);
      return opt ? `${s.label}: ${opt.label}` : '';
    }).filter(Boolean).join(' · ');
    if (isHost) {
      $('#gn-settings').innerHTML = (online.settings || []).map((s) => `
        <p class="label">${esc(s.label)}</p>
        <div class="seg" role="radiogroup" aria-label="${esc(s.label)}">
          ${s.options.map((o) => `<button type="button" role="radio" data-key="${esc(s.key)}" data-value="${esc(o.value)}" aria-checked="${v.settings?.[s.key] === o.value}">${esc(o.label)}</button>`).join('')}
        </div>`).join('');
      const ready = present.filter((p) => !p.away || p.id === v.host).length;
      $('#gn-start').disabled = ready < online.minPlayers;
      $('#gn-start-hint').textContent = ready < online.minPlayers
        ? `Share the room code. You need at least ${online.minPlayers} players.`
        : `${Math.min(ready, online.maxPlayers)} player${Math.min(ready, online.maxPlayers) === 1 ? '' : 's'} ready.`;
    } else {
      const host = v.players.find((p) => p.id === v.host);
      $('#gn-host-name').textContent = host ? host.name : 'the host';
      $('#gn-guest-settings').textContent = summary;
    }
  }

  // Start: resume a room after a refresh, or pre-fill an invite link.
  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  show('gn-home');
  const resumed = room.resume(() => showBusy('Still reconnecting… Check your internet connection.', true));
  if (resumed) {
    showBusy('Reconnecting to your room…', true);
    resumed.then((ok) => { if (!ok) { hideBusy(); goHome(); } }).catch((err) => { hideBusy(); goHome(); if (err.message !== 'cancelled') showError(err.message); });
  } else if (urlRoom.length === 4) {
    selectTab('join');
    $('#gn-code-in').value = urlRoom;
    if (!$('#gn-name').value) $('#gn-name').focus();
  }

  // Read-only hooks for automated browser tests.
  window.__gn = { view: () => room.view, role: () => room.role };
  return { room, toast };
}
