import { setupDiary } from './diary.js';
import { setupMaps } from './maps.js';
import { setupHeroes } from './heroes.js';
const $ = id => document.getElementById(id);
const labels = { public: 'Public', private: 'Only me', gm: 'To GM' };
const visibilityHelp = {
  public: 'Everyone at your table can see this roll.',
  private: 'Only you can see this roll. Even the GM cannot see it.',
  gm: 'Only you and the game master can see this roll.',
};
let mode = 'create';
let current = null;
let events = null;
let toastTimer;
let drag = null;
let maximized = false;
let normalPosition = null;
let diceTray = null;
let trayModule;
let trayGeneration = 0;
const diary = setupDiary({ getAccount: () => current?.me, api, toast });
const mapRoom = setupMaps({ getContext: () => current, api, toast });
const heroes = setupHeroes({ getAccount: () => current?.me, api, toast });
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
try { $('enable-3d').checked = localStorage.getItem('tavern:3d-dice') !== 'off'; } catch { /* default enabled */ }

function stopDiceAnimation() { trayGeneration++; diceTray?.stop(); }
function resetDiceTray() { stopDiceAnimation(); diceTray?.dispose(); diceTray = null; }
async function updateDiceStage(roll, animate = false) {
  const generation = ++trayGeneration, accountId = current?.me.id;
  if (!current || $('dice-window').hidden) return;
  const enabled = $('enable-3d').checked;
  const sides = Number(roll?.expression.match(/d(\d+)/)?.[1]);
  const supported = [4, 6, 8, 10, 12, 20].includes(sides);
  $('replay-roll').disabled = true;
  $('dice-stage').dataset.mode = enabled && (!roll || supported) ? '3d' : 'fallback';
  if (!enabled || !roll || !supported) {
    diceTray?.reset();
    $('tray-placeholder').hidden = false;
    $('tray-placeholder').querySelector('span').textContent = !enabled ? 'Your result, without the tumble.' : !roll ? 'Your next roll lands here.' : 'Every result still counts.';
    $('tray-status').textContent = !enabled ? '3D off · numbers remain below.' : !roll ? 'A little momentum. A little luck.' : `d${sides} uses the numeric result below.`;
    return;
  }
  const shouldAnimate = animate && !reducedMotion.matches && !document.hidden;
  $('tray-status').textContent = shouldAnimate ? 'Rolling on the table…' : 'Placing the dice…';
  try {
    const { DiceTray } = await (trayModule ??= import('/dice3d.js'));
    if (generation !== trayGeneration || current?.me.id !== accountId || $('dice-window').hidden) return;
    if (!diceTray) diceTray = new DiceTray($('dice-canvas'), () => {
      resetDiceTray();
      $('tray-placeholder').hidden = false;
      $('dice-stage').dataset.mode = 'fallback';
      $('tray-placeholder').querySelector('span').textContent = 'Your result is still here.';
      $('tray-status').textContent = '3D unavailable on this device · use the numbers below.';
      $('replay-roll').disabled = true;
    });
    $('tray-placeholder').hidden = true;
    await diceTray.show(roll, { animate: shouldAnimate, onComplete: () => {
      if (generation !== trayGeneration || current?.me.id !== accountId) return;
      $('tray-status').textContent = reducedMotion.matches ? 'Reduced motion · dice placed instantly.' : 'Settled · the same result as your roll.';
      $('replay-roll').disabled = reducedMotion.matches;
    } });
  } catch {
    if (generation !== trayGeneration || current?.me.id !== accountId) return;
    trayModule = null;
    resetDiceTray();
    $('tray-placeholder').hidden = false;
    $('dice-stage').dataset.mode = 'fallback';
    $('tray-placeholder').querySelector('span').textContent = 'Your result is still here.';
    $('tray-status').textContent = '3D unavailable on this device · use the numbers below.';
  }
}
$('enable-3d').addEventListener('change', () => {
  if (!$('enable-3d').checked) resetDiceTray();
  try { localStorage.setItem('tavern:3d-dice', $('enable-3d').checked ? 'on' : 'off'); } catch { /* preference is optional */ }
  updateDiceStage(current?.rolls.at(-1));
});
$('replay-roll').addEventListener('click', () => updateDiceStage(current?.rolls.at(-1), true));
reducedMotion.addEventListener('change', () => updateDiceStage(current?.rolls.at(-1)));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopDiceAnimation();
  else updateDiceStage(current?.rolls.at(-1));
});

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function api(path, body) {
  const requestingAccount = current?.me.id;
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && current && current.me.id === requestingAccount) leaveWorkspace();
    throw Object.assign(new Error(result.error || 'Something went wrong. Please try again.'), { status: response.status });
  }
  return result;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

function showError(id, message) {
  $(id).textContent = message || '';
  $(id).hidden = !message;
}

function setMode(next) {
  mode = next;
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
  $('campaign-label').hidden = mode !== 'create';
  $('room-name').required = mode === 'create';
  $('code-label').hidden = mode === 'create';
  $('room-code').required = mode !== 'create';
  $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('enter-button').textContent = { create: 'Create your table ↗', join: 'Join the adventure ↗', login: 'Welcome back ↗' }[mode];
  $('entrance-description').textContent = { create: 'Start a campaign and invite your party.', join: 'An invitation, a name, and a new adventure.', login: 'Your table is right where you left it.' }[mode];
  $('account-hint').textContent = {
    create: 'You’ll be the game master. Your friends join with an invitation code and create their own accounts.',
    join: 'Use your GM’s invitation code and choose your own name and password. Already have an account? Use Sign in.',
    login: 'Use the same invitation code, name and password you used to create your account.',
  }[mode];
  showError('account-error', '');
}
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));

$('account-form').addEventListener('submit', async event => {
  event.preventDefault();
  showError('account-error', '');
  $('enter-button').disabled = true;
  try {
    await api({ create: '/api/rooms', join: '/api/join', login: '/api/login' }[mode], {
      roomName: $('room-name').value,
      roomCode: $('room-code').value,
      username: $('username').value,
      password: $('password').value,
    });
    $('password').value = '';
    history.replaceState(null, '', location.pathname);
    enterWorkspace(await api('/api/state'));
  } catch (error) { showError('account-error', error.message); }
  finally { $('enter-button').disabled = false; }
});

function initials(name) { return name.split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase(); }

function renderMembers() {
  if (!current) return;
  $('members').replaceChildren(...current.members.map(member => {
    const li = node('li', 'member');
    const details = node('div', 'member-info');
    details.append(node('strong', '', `${member.name}${member.id === current.me.id ? ' (you)' : ''}`), node('small', '', member.role === 'gm' ? 'Game master' : 'Adventurer'));
    const dot = node('span', `online-dot${member.online ? ' online' : ''}`);
    dot.title = member.online ? 'Online' : 'Offline';
    dot.setAttribute('aria-label', dot.title);
    li.append(node('span', 'avatar', initials(member.name)), details, dot);
    return li;
  }));
  $('member-count').textContent = `${current.members.length} / 6`;
}

function setConnection(connected) {
  $('connection').classList.toggle('live', connected);
  $('connection').replaceChildren(node('span'), document.createTextNode(connected ? 'Live' : 'Reconnecting…'));
}

function connect() {
  events?.close();
  const accountId = current?.me.id;
  if (current?.transport === 'websocket') {
    events = connectWebSocket(accountId);
    return;
  }
  events = new EventSource('/api/events');
  events.addEventListener('snapshot', event => {
    if (!current || current.me.id !== accountId) return;
    current = JSON.parse(event.data);
    mapRoom.changed();
    diary.changed();
    setConnection(true);
    renderMembers();
    renderRolls();
    showLatestRoll(current.rolls.at(-1));
  });
  events.addEventListener('diary', event => { if (current?.me.id === accountId) diary.changed(JSON.parse(event.data)); });
  events.addEventListener('map', event => { if (current?.me.id === accountId) mapRoom.changed(JSON.parse(event.data)); });
  events.addEventListener('roll', event => {
    if (!current || current.me.id !== accountId) return;
    appendRoll(JSON.parse(event.data), true);
  });
  events.addEventListener('presence', event => {
    if (!current || current.me.id !== accountId) return;
    const { online } = JSON.parse(event.data);
    current.members.forEach(member => { member.online = online.includes(member.id); });
    renderMembers();
  });
  events.addEventListener('members', event => {
    if (!current || current.me.id !== accountId) return;
    current.members = JSON.parse(event.data).members;
    renderMembers();
    mapRoom.changed({ image: false });
  });
  events.addEventListener('expired', () => { if (current?.me.id === accountId) { leaveWorkspace(); toast('Your session has ended. Please sign in again.'); } });
  events.onerror = async () => {
    if (!current || current.me.id !== accountId) return;
    setConnection(false);
    // EventSource reconnects automatically; this also detects revoked sessions.
    try { await api('/api/state'); } catch { /* api handles an expired login */ }
  };
}

function receivePacket(accountId, type, data) {
  if (!current || current.me.id !== accountId) return;
  if (type === 'snapshot') {
    if (data.me.id !== accountId) return;
    current = data;
    mapRoom.changed();
    diary.changed();
    setConnection(true);
    renderMembers();
    renderRolls();
    showLatestRoll(current.rolls.at(-1));
  } else if (type === 'diary') diary.changed(data);
  else if (type === 'map') mapRoom.changed(data);
  else if (type === 'roll') appendRoll(data, true);
  else if (type === 'presence') {
    current.members.forEach(member => { member.online = data.online.includes(member.id); });
    renderMembers();
  } else if (type === 'members') {
    current.members = data.members;
    renderMembers();
    mapRoom.changed({ image: false });
  } else if (type === 'expired') {
    leaveWorkspace();
    toast('Your session has ended. Please sign in again.');
  }
}

function connectWebSocket(accountId) {
  let socket;
  let reconnectTimer;
  let stopped = false;
  let retries = 0;
  let keepalive;
  const open = () => {
    if (stopped || current?.me.id !== accountId) return;
    const url = new URL('/api/events', location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(url);
    socket.onopen = () => {
      retries = 0;
      // Cloudflare answers this without waking the campaign object.
      keepalive = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('ping'); }, 45_000);
    };
    socket.onmessage = event => {
      if (stopped || event.data === 'pong') return;
      try {
        const packet = JSON.parse(event.data);
        receivePacket(accountId, packet.type, packet.data);
      } catch { /* ignore malformed transport messages */ }
    };
    socket.onclose = async () => {
      clearInterval(keepalive);
      if (stopped || current?.me.id !== accountId) return;
      setConnection(false);
      try { await api('/api/state'); } catch { /* api clears a revoked login */ }
      if (stopped || current?.me.id !== accountId) return;
      reconnectTimer = setTimeout(open, Math.min(1000 * 2 ** retries++, 15_000));
    };
    socket.onerror = () => { if (!stopped && current?.me.id === accountId) setConnection(false); };
  };
  open();
  return { close() { stopped = true; clearTimeout(reconnectTimer); clearInterval(keepalive); socket?.close(); } };
}

function enterWorkspace(state) {
  current = state;
  $('entrance').hidden = true;
  $('workspace').hidden = false;
  $('campaign-name').textContent = state.room.name;
  document.title = `${state.room.name} · The Tavern`;
  $('invite-code').textContent = state.room.code;
  $('my-name').textContent = state.me.name;
  $('my-role').textContent = state.me.role === 'gm' ? 'Game master' : 'Adventurer';
  $('my-avatar').textContent = initials(state.me.name);
  $('history-filter').value = 'all';
  $('latest-roll').replaceChildren();
  $('latest-roll').hidden = true;
  document.querySelector('input[name=visibility][value=public]').checked = true;
  $('visibility-help').textContent = visibilityHelp.public;
  renderMembers();
  renderRolls();
  showLatestRoll(current.rolls.at(-1));
  connect();
  $('open-dice').focus();
}

function leaveWorkspace() {
  diary.reset();
  mapRoom.reset();
  heroes.reset();
  resetDiceTray();
  events?.close();
  events = null;
  closeDice();
  current = null;
  $('entrance').hidden = false;
  $('workspace').hidden = true;
  $('roll-history').replaceChildren();
  $('latest-roll').replaceChildren();
  $('latest-roll').hidden = true;
  $('members').replaceChildren();
  $('invite-code').textContent = '';
  $('password').value = '';
  $('roll-label').value = '';
  $('announcement').textContent = '';
  clearTimeout(toastTimer);
  $('toast').textContent = '';
  $('toast').hidden = true;
  document.title = 'The Tavern · A table of your own';
  setMode('login');
  $('username').focus();
}

$('sign-out').addEventListener('click', async () => {
  try { await api('/api/logout', {}); leaveWorkspace(); }
  catch (error) { toast(error.message); }
});
$('copy-invite').addEventListener('click', async () => {
  if (!current) return;
  const link = `${location.origin}/#join=${current.room.code}`;
  try { await navigator.clipboard.writeText(link); toast('Invitation copied. Share it with your party.'); }
  catch { toast(`Invitation code: ${current.room.code}`); }
});

function appendRoll(roll, announce = false) {
  if (!current || current.rolls.some(item => item.id === roll.id)) return;
  current.rolls.push(roll);
  if (current.rolls.length > 100) current.rolls.shift();
  renderRolls();
  showLatestRoll(roll, true);
  if (announce) {
    $('announcement').textContent = `${roll.author} rolled ${roll.expression}: ${roll.results.join(', ')}. Total ${roll.total}. ${labels[roll.visibility]}.`;
    if ($('dice-window').hidden) toast(`${roll.author} rolled ${roll.expression}: ${roll.total} · ${labels[roll.visibility]}`);
  }
}

function showLatestRoll(roll, animate = false) {
  updateDiceStage(roll, animate);
  if (!roll) return;
  const latest = $('latest-roll');
  const dice = node('div', 'result-dice');
  dice.append(...roll.results.map(value => node('span', 'die-chip', String(value))));
  if (roll.modifier) dice.append(node('span', '', `${roll.modifier > 0 ? '+' : '−'} ${Math.abs(roll.modifier)}`));
  latest.replaceChildren(
    node('div', 'result-eyebrow', `${roll.author} · ${roll.expression.toUpperCase()} · TOTAL`),
    node('div', 'result-total', String(roll.total)), dice,
    node('p', 'result-caption', `${labels[roll.visibility]}${roll.label ? ` · ${roll.label}` : ''}`),
  );
  latest.hidden = false;
}

function renderRolls() {
  if (!current) return;
  const filter = $('history-filter').value;
  const rolls = current.rolls.filter(roll => filter === 'all' || roll.visibility === filter).slice().reverse();
  $('history-empty').hidden = rolls.length > 0;
  $('roll-history').replaceChildren(...rolls.map(roll => {
    const li = node('li', 'history-item');
    li.dataset.rollId = roll.id;
    const top = node('div', 'history-top');
    const time = node('time', 'history-time', new Date(roll.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    time.dateTime = roll.createdAt;
    time.title = new Date(roll.createdAt).toLocaleString();
    top.append(node('span', 'history-author', roll.author), node('span', `visibility-badge ${roll.visibility}`, labels[roll.visibility]), time);
    const result = node('div', 'history-result');
    result.append(node('span', 'history-expression', roll.expression), node('span', '', '→'), node('strong', 'history-total', String(roll.total)));
    li.append(top, result, node('p', 'history-detail', `[${roll.results.join(' · ')}]${roll.modifier ? ` ${roll.modifier > 0 ? '+' : '−'} ${Math.abs(roll.modifier)}` : ''}${roll.label ? ` — ${roll.label}` : ''}`));
    return li;
  }));
}
$('history-filter').addEventListener('change', renderRolls);

document.querySelectorAll('[data-dice]').forEach(button => button.addEventListener('click', () => {
  $('expression').value = button.dataset.dice;
  markQuickDice();
}));
function markQuickDice() { document.querySelectorAll('[data-dice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.dice === $('expression').value))); }
$('expression').addEventListener('input', markQuickDice);
document.querySelectorAll('input[name=visibility]').forEach(input => input.addEventListener('change', () => { $('visibility-help').textContent = visibilityHelp[input.value]; }));

$('roll-form').addEventListener('submit', async event => {
  event.preventDefault();
  const accountId = current?.me.id;
  showError('roll-error', '');
  $('roll-button').disabled = true;
  try {
    const { roll } = await api('/api/rolls', { expression: $('expression').value, label: $('roll-label').value, visibility: document.querySelector('input[name=visibility]:checked').value });
    if (!current || current.me.id !== accountId) return;
    appendRoll(roll, true);
    if ($('enable-3d').checked && !$('dice-window').hidden) $('dice-tray-panel').scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  } catch (error) { showError('roll-error', error.message); }
  finally { $('roll-button').disabled = false; }
});

function storageKey() { return `tavern:dice-window:${current?.me.id}`; }
function savePosition() {
  if (!current || maximized) return;
  const { x, y, width, height } = $('dice-window').getBoundingClientRect();
  try { localStorage.setItem(storageKey(), JSON.stringify({ x, y, width, height })); } catch { /* layout still works with storage disabled */ }
}
function clampWindow() {
  const win = $('dice-window');
  if (win.hidden || maximized) return;
  const rect = win.getBoundingClientRect();
  win.style.left = `${Math.max(8, Math.min(rect.x, innerWidth - rect.width - 8))}px`;
  win.style.top = `${Math.max(8, Math.min(rect.y, innerHeight - Math.min(rect.height, innerHeight - 65) - 57))}px`;
}
function openDice() {
  if (!current) return;
  const win = $('dice-window');
  if ($('restore-dice').hidden) {
    win.removeAttribute('style');
    win.classList.remove('maximized');
    maximized = false;
    $('maximize-dice').setAttribute('aria-label', 'Maximize dice window');
    if (innerWidth > 680) {
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey()));
        if (saved && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(saved[key]))) {
          win.style.left = `${saved.x}px`; win.style.top = `${saved.y}px`;
          win.style.width = `${Math.max(340, Math.min(saved.width, innerWidth - 24))}px`;
          win.style.height = `${Math.max(300, Math.min(saved.height, innerHeight - 80))}px`;
        }
      } catch { /* default layout */ }
    }
  }
  win.hidden = false;
  win.style.zIndex = '34'; $('hero-window').style.zIndex = '30'; $('map-window').style.zIndex = '30'; $('diary-window').style.zIndex = '30';
  $('restore-dice').hidden = false;
  $('window-state').textContent = 'Open';
  clampWindow();
  updateDiceStage(current.rolls.at(-1));
  $('expression').focus({ preventScroll: true });
}
function closeDice() {
  stopDiceAnimation();
  savePosition();
  $('dice-window').hidden = true;
  $('restore-dice').hidden = true;
  if (current) $('open-dice').focus({ preventScroll: true });
}
$('open-dice').addEventListener('click', openDice);
$('restore-dice').addEventListener('click', openDice);
$('close-dice').addEventListener('click', closeDice);
$('minimize-dice').addEventListener('click', () => {
  stopDiceAnimation();
  savePosition();
  $('dice-window').hidden = true;
  $('window-state').textContent = 'Minimized';
  $('restore-dice').focus();
});
$('maximize-dice').addEventListener('click', () => {
  const win = $('dice-window');
  if (!maximized) { normalPosition = win.getAttribute('style'); savePosition(); }
  maximized = !maximized;
  win.classList.toggle('maximized', maximized);
  if (!maximized) { if (normalPosition) win.setAttribute('style', normalPosition); else win.removeAttribute('style'); clampWindow(); }
  $('maximize-dice').setAttribute('aria-label', maximized ? 'Restore dice window size' : 'Maximize dice window');
});
$('dice-drag').addEventListener('pointerdown', event => {
  if (event.target.closest('button') || maximized || event.button !== 0) return;
  const rect = $('dice-window').getBoundingClientRect();
  drag = { pointerId: event.pointerId, dx: event.clientX - rect.x, dy: event.clientY - rect.y };
  $('dice-drag').setPointerCapture(event.pointerId);
});
$('dice-drag').addEventListener('pointermove', event => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const win = $('dice-window');
  win.style.left = `${Math.max(8, Math.min(event.clientX - drag.dx, innerWidth - win.offsetWidth - 8))}px`;
  win.style.top = `${Math.max(8, Math.min(event.clientY - drag.dy, innerHeight - 100))}px`;
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('dice-drag').addEventListener(type, () => { if (drag) { drag = null; savePosition(); } });
$('dice-window').addEventListener('pointerup', savePosition);
window.addEventListener('resize', clampWindow);
window.addEventListener('pagehide', () => { savePosition(); events?.close(); });
window.addEventListener('pageshow', event => { if (event.persisted && current) connect(); });

// Keep independent tools usable when their windows overlap.
for (const win of document.querySelectorAll('.floating-window')) win.addEventListener('pointerdown', () => {
  for (const other of document.querySelectorAll('.floating-window')) other.style.zIndex = other === win ? '35' : '30';
});
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const top = [...document.querySelectorAll('.floating-window:not([hidden])')].sort((a, b) => Number(b.style.zIndex || 30) - Number(a.style.zIndex || 30))[0];
  if (!top) return;
  event.preventDefault(); event.stopImmediatePropagation(); top.querySelector('button[id^="close-"]')?.click();
}, { capture: true });

const invitation = new URLSearchParams(location.hash.slice(1)).get('join');
if (invitation && /^[a-fA-F0-9]{16}$/.test(invitation)) { setMode('join'); $('room-code').value = invitation; }
try { enterWorkspace(await api('/api/state')); }
catch (error) { if (!error.message.includes('sign in')) showError('account-error', error.message); }
