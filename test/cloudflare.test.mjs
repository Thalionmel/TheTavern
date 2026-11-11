import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const origin = 'https://tavern.example';
const password = 'cloudflare-test-password';
const workerOptions = {
  name: 'the-tavern',
  modules: true,
  scriptPath: resolve('work/cloudflare-build/worker.js'),
  compatibilityDate: '2026-11-11',
  compatibilityFlags: ['nodejs_compat'],
  durableObjects: {
    CAMPAIGNS: { className: 'CampaignRoom', useSQLite: true },
    REQUEST_GUARDS: { className: 'RequestGuard', useSQLite: true },
  },
  assets: { directory: resolve('public'), binding: 'ASSETS', run_worker_first: ['/api/*', '/healthz'], routerConfig: { has_user_worker: true } },
  log: new Log(LogLevel.ERROR),
};
const runtime = (options = {}) => new Miniflare(convertV4MiniflareOptions({ ...workerOptions, ...options }));

async function fixture(t, options = {}) {
  const mf = runtime(options);
  await mf.ready;
  t.after(() => mf.dispose());
  const client = () => {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async request(path, body, extra = {}) {
        const res = await mf.dispatchFetch(origin + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
        const text = await res.text();
        assert.ok(res.headers.get('Content-Type')?.includes('application/json'), text);
        return { status: res.status, headers: res.headers, value: JSON.parse(text) };
      },
      async stream() {
        const res = await mf.dispatchFetch(origin + '/api/events', { headers: { Cookie: cookie, Origin: origin, Upgrade: 'websocket' } });
        assert.equal(res.status, 101);
        const socket = res.webSocket;
        const messages = [];
        socket.addEventListener('message', event => {
          if (event.data === 'pong') messages.push({ type: 'pong', data: {} });
          else messages.push(JSON.parse(event.data));
        });
        socket.accept();
        t.after(() => { try { socket.close(); } catch { /* runtime already disposed */ } });
        const stream = {
          socket, messages,
          async wait(predicate, timeout = 3000) {
            const until = Date.now() + timeout;
            while (Date.now() < until) { const found = messages.find(predicate); if (found) return found; await delay(10); }
            assert.fail('Expected Cloudflare WebSocket event did not arrive.');
          },
        };
        await stream.wait(message => message.type === 'snapshot');
        return stream;
      },
    };
  };
  return { mf, client };
}

async function party(t, options) {
  const f = await fixture(t, options);
  const gm = f.client();
  const created = await gm.request('/api/rooms', { roomName: 'Cloud tavern', username: 'GM', password });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  assert.match(created.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(created.headers.get('set-cookie'), /Secure/);
  const state = (await gm.request('/api/state')).value;
  assert.equal(state.transport, 'websocket');
  const roomCode = state.room.code;
  const alice = f.client(); const bob = f.client();
  for (const [account, username] of [[alice, 'Alice'], [bob, 'Bob']]) assert.equal((await account.request('/api/join', { roomCode, username, password })).status, 201);
  return { ...f, gm, alice, bob, roomCode };
}

test('Cloudflare: live audiences and history remain private across hibernation', async t => {
  const { mf, gm, alice, bob, roomCode } = await party(t);
  const streams = await Promise.all([gm.stream(), alice.stream(), bob.stream()]);
  const [g, a, b] = streams;
  const posted = {};
  for (const visibility of ['public', 'private', 'gm']) {
    if (visibility !== 'public') await mf.unsafeEvictDurableObject('the-tavern', 'CampaignRoom', { name: roomCode, webSockets: 'hibernate' });
    const res = await alice.request('/api/rolls', { expression: '3d20', visibility, label: `${visibility}-canary`, authorId: 'forged', role: 'gm' });
    assert.equal(res.status, 201);
    posted[visibility] = res.value.roll;
    assert.equal(res.value.roll.author, 'Alice');
    assert.equal(res.value.roll.results.length, 3);
    await a.wait(message => message.type === 'roll' && message.data.id === res.value.roll.id);
  }
  const barrier = (await bob.request('/api/rolls', { expression: 'd6', visibility: 'public' })).value.roll;
  for (const s of streams) await s.wait(message => message.type === 'roll' && message.data.id === barrier.id);
  for (const s of [g, b]) assert.ok(!JSON.stringify(s.messages).includes(posted.private.id));
  assert.ok(!JSON.stringify(b.messages).includes(posted.gm.id));
  assert.ok(JSON.stringify(g.messages).includes(posted.gm.id));
  for (const [account, expected] of [[gm, ['public', 'gm']], [alice, ['public', 'private', 'gm']], [bob, ['public']]]) {
    const history = (await account.request('/api/rolls')).value.rolls;
    for (const visibility of ['public', 'private', 'gm']) assert.equal(history.some(roll => roll.id === posted[visibility].id), expected.includes(visibility));
    const reconnect = await account.stream();
    const snapshot = reconnect.messages.find(message => message.type === 'snapshot').data;
    for (const visibility of ['public', 'private', 'gm']) assert.equal(snapshot.rolls.some(roll => roll.id === posted[visibility].id), expected.includes(visibility));
  }
});

test('Cloudflare: account login, case-insensitive names and six seats cannot grant extra GM roles', async t => {
  const { client, alice, roomCode } = await party(t);
  assert.equal((await client().request('/api/state')).status, 401);
  assert.equal((await client().request('/api/join', { roomCode, username: 'ALICE', password })).status, 409);
  const login = client();
  assert.equal((await login.request('/api/login', { roomCode, username: 'alice', password: 'wrong-password' })).status, 401);
  assert.equal((await login.request('/api/login', { roomCode, username: 'alice', password })).status, 200);
  assert.equal((await login.request('/api/state')).value.me.id, (await alice.request('/api/state')).value.me.id);
  for (const username of ['Carla', 'Doran', 'Erin']) {
    const account = client();
    assert.equal((await account.request('/api/join', { roomCode, username, password, role: 'gm' })).status, 201);
    assert.equal((await account.request('/api/state')).value.me.role, 'player');
  }
  assert.equal((await client().request('/api/join', { roomCode, username: 'Seventh', password })).status, 409);
});

test('Cloudflare: room routing and forged cookies cannot cross campaign boundaries', async t => {
  const { client, alice, roomCode } = await party(t);
  const other = client();
  await other.request('/api/rooms', { roomName: 'Another room', username: 'Other GM', password });
  const otherState = (await other.request('/api/state')).value;
  const stream = await other.stream();
  const secret = (await alice.request('/api/rolls', { expression: 'd20', visibility: 'public', roomCode: otherState.room.code })).value.roll;
  const barrier = (await other.request('/api/rolls', { expression: 'd20', visibility: 'public' })).value.roll;
  await stream.wait(message => message.type === 'roll' && message.data.id === barrier.id);
  assert.ok(!JSON.stringify(stream.messages).includes(secret.id));
  assert.ok(!(await other.request('/api/rolls')).value.rolls.some(roll => roll.id === secret.id));
  const forgedCookie = alice.cookie.replace(roomCode, otherState.room.code);
  assert.equal((await client().request('/api/state', undefined, { Cookie: forgedCookie, 'X-Tavern-Room': roomCode })).status, 401);
});

test('Cloudflare: HTTP and WebSocket origins are checked; invalid rolls cannot be saved', async t => {
  const { mf, alice } = await party(t);
  const roll = { expression: 'd20', visibility: 'public' };
  assert.equal((await alice.request('/api/rolls', roll, { Origin: 'https://attacker.example' })).status, 403);
  for (const body of [{ expression: 'd20' }, { ...roll, visibility: 'unknown' }, { ...roll, expression: '21d20' }, { ...roll, label: 'x'.repeat(81) }]) assert.equal((await alice.request('/api/rolls', body)).status, 400);
  const socket = await mf.dispatchFetch(origin + '/api/events', { headers: { Cookie: alice.cookie, Origin: 'https://attacker.example', Upgrade: 'websocket' } });
  assert.equal(socket.status, 403);
  assert.equal((await alice.request('/api/events')).status, 426);
  assert.deepEqual((await alice.request('/api/rolls')).value.rolls, []);
});

test('Cloudflare: logout revokes sockets, and auto-response pings do not carry private data', async t => {
  const { mf, alice } = await party(t);
  const stream = await alice.stream();
  stream.socket.send('ping');
  await stream.wait(message => message.type === 'pong');
  const oldCookie = alice.cookie;
  await alice.request('/api/logout', {});
  assert.equal((await alice.request('/api/state', undefined, { Cookie: oldCookie })).status, 401);
  const upgrade = await mf.dispatchFetch(origin + '/api/events', { headers: { Cookie: oldCookie, Origin: origin, Upgrade: 'websocket' } });
  assert.equal(upgrade.status, 401);
});

test('Cloudflare: expired sessions cannot receive subsequent live results', async t => {
  const { client } = await fixture(t, { bindings: { SESSION_TTL_MS: '1200' } });
  const account = client();
  assert.equal((await account.request('/api/rooms', { roomName: 'Expiry test', username: 'GM', password })).status, 201);
  const roomCode = (await account.request('/api/state')).value.room.code;
  const stream = await account.stream();
  await delay(1400);
  assert.equal((await account.request('/api/state')).status, 401);
  assert.equal((await account.request('/api/login', { roomCode, username: 'GM', password })).status, 200);
  const fresh = (await account.request('/api/rolls', { expression: 'd20', visibility: 'public' })).value.roll;
  await stream.wait(message => message.type === 'expired');
  assert.ok(!JSON.stringify(stream.messages).includes(fresh.id));
});

test('Cloudflare: persistent room data and session authorization survive a runtime restart', async t => {
  mkdirSync(resolve('work'), { recursive: true });
  const directory = mkdtempSync(resolve('work/cloudflare-persistence-'));
  let mf = runtime({ resourcePersistencePath: directory });
  await mf.ready;
  t.after(async () => { await mf.dispose(); rmSync(directory, { recursive: true, force: true }); });
  let cookie = '';
  const send = async (path, body) => {
    const res = await mf.dispatchFetch(origin + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, value: await res.json() };
  };
  assert.equal((await send('/api/rooms', { roomName: 'Persistent campaign', username: 'GM', password })).status, 201);
  const before = (await send('/api/state')).value;
  const roll = (await send('/api/rolls', { expression: 'd20', visibility: 'private' })).value.roll;
  await mf.dispose();
  mf = runtime({ resourcePersistencePath: directory });
  await mf.ready;
  const restored = await send('/api/state');
  assert.equal(restored.status, 200, JSON.stringify(restored.value));
  const after = restored.value;
  assert.equal(after.me.id, before.me.id);
  assert.deepEqual(after.rolls, [roll]);
});

test('Cloudflare: per-account roll limits survive hibernation without blocking other players', async t => {
  const { mf, alice, bob, roomCode } = await party(t);
  for (let i = 0; i < 60; i++) assert.equal((await alice.request('/api/rolls', { expression: 'd20', visibility: 'private' })).status, 201);
  await mf.unsafeEvictDurableObject('the-tavern', 'CampaignRoom', { name: roomCode, webSockets: 'hibernate' });
  assert.equal((await alice.request('/api/rolls', { expression: 'd20', visibility: 'public' })).status, 429);
  assert.equal((await bob.request('/api/rolls', { expression: 'd20', visibility: 'public' })).status, 201);
  assert.equal((await alice.request('/api/rolls')).value.rolls.length, 61);
  assert.equal((await bob.request('/api/rolls')).value.rolls.length, 1);
});

test('Cloudflare: authentication attempts are bounded before password hashing', async t => {
  const { client } = await fixture(t);
  const account = client();
  for (let i = 0; i < 10; i++) assert.equal((await account.request('/api/rooms', { username: '', password })).status, 400);
  assert.equal((await account.request('/api/rooms', { roomName: 'Blocked', username: 'GM', password })).status, 429);
});

test('Cloudflare: static assets are served, and source/storage files stay inaccessible', async t => {
  const { mf } = await fixture(t);
  const page = await mf.dispatchFetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /The Tavern/);
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  for (const path of ['/server.mjs', '/cloudflare/worker.mjs', '/.dev.vars', '/data/tavern.sqlite']) assert.equal((await mf.dispatchFetch(origin + path)).status, 404);
});
