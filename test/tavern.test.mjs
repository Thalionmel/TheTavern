import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTavern } from '../server.mjs';
import { parseDice, rollDice } from '../lib/dice.mjs';

const password = 'adventure-test-password';

async function fixture(t, options = {}) {
  const app = createTavern({ databasePath: ':memory:', ...options });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  const client = () => {
    let cookie = '';
    return {
      get cookie() { return cookie; },
      async request(path, body, extra = {}) {
        const response = await fetch(`${origin}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Origin: origin, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        const value = await response.json();
        return { status: response.status, value, headers: response.headers };
      },
      async stream() {
        const controller = new AbortController();
        const response = await fetch(`${origin}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
        assert.equal(response.status, 200);
        const messages = [];
        const decoder = new TextDecoder();
        let buffered = '';
        const reader = response.body.getReader();
        const pumping = (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffered += decoder.decode(value, { stream: true });
              let split;
              while ((split = buffered.indexOf('\n\n')) >= 0) {
                const packet = buffered.slice(0, split); buffered = buffered.slice(split + 2);
                const type = packet.match(/^event: (.+)$/m)?.[1];
                const data = packet.match(/^data: (.+)$/m)?.[1];
                if (type && data) messages.push({ type, data: JSON.parse(data) });
              }
            }
          } catch (err) { if (err.name !== 'AbortError') throw err; }
        })();
        const stream = {
          messages,
          async close() { controller.abort(); await pumping; },
          async wait(predicate, timeout = 2000) {
            const until = Date.now() + timeout;
            while (Date.now() < until) { const found = messages.find(predicate); if (found) return found; await delay(10); }
            assert.fail('Expected live event did not arrive.');
          },
        };
        t.after(() => stream.close());
        await stream.wait(message => message.type === 'snapshot');
        return stream;
      },
    };
  };
  return { app, origin, client };
}

async function party(t, options) {
  const f = await fixture(t, options);
  const gm = f.client();
  assert.equal((await gm.request('/api/rooms', { roomName: 'The Grey Road', username: 'Game Master', password })).status, 201);
  const state = (await gm.request('/api/state')).value;
  const roomCode = state.room.code;
  const alice = f.client(); const bob = f.client();
  for (const [user, username] of [[alice, 'Alice'], [bob, 'Bob']]) {
    assert.equal((await user.request('/api/join', { roomCode, username, password })).status, 201);
  }
  return { ...f, gm, alice, bob, roomCode };
}

test('dice notation validates bounds and preserves individual results', () => {
  assert.deepEqual(parseDice(' 3D20 + 4 '), { count: 3, sides: 20, modifier: 4, expression: '3d20+4' });
  for (const input of ['0d6', '21d6', 'd1', '1d1001', '1d20+10001', '1d20;alert(1)', '', null, '2d6+2d20']) assert.throws(() => parseDice(input));
  for (let i = 0; i < 100; i++) {
    const roll = rollDice('3d20-2');
    assert.equal(roll.results.length, 3);
    assert.ok(roll.results.every(result => Number.isInteger(result) && result >= 1 && result <= 20));
    assert.equal(roll.total, roll.results.reduce((sum, result) => sum + result, -2));
  }
});

test('accounts require authentication, hash passwords, and assign roles on the server', async t => {
  const { client, gm, alice, roomCode } = await party(t);
  assert.equal((await client().request('/api/state')).status, 401);
  assert.equal((await client().request('/api/rolls')).status, 401);
  const state = await alice.request('/api/state');
  assert.equal(state.value.me.role, 'player');
  assert.ok(!JSON.stringify(state.value).includes(password));
  const forged = client();
  assert.equal((await forged.request('/api/join', { roomCode, username: 'Forged GM', password, role: 'gm' })).status, 201);
  assert.equal((await forged.request('/api/state')).value.me.role, 'player');
  const badLogin = await client().request('/api/login', { roomCode, username: 'Alice', password: 'wrong-password' });
  assert.equal(badLogin.status, 401);
  const login = client();
  assert.equal((await login.request('/api/login', { roomCode, username: 'alice', password })).status, 200);
  assert.equal((await login.request('/api/state')).value.me.id, state.value.me.id);
  assert.match(login.cookie, /^tavern_session=[a-f0-9]{64}$/);
  assert.equal((await gm.request('/api/state')).value.me.role, 'gm');
});

test('public rolls arrive live in a different account, once, with server-owned identity', async t => {
  const { alice, bob } = await party(t);
  const stream = await bob.stream();
  const response = await alice.request('/api/rolls', { expression: '3d20', visibility: 'public', label: 'Climb the wall', author: 'Bob', authorId: 'forged' });
  assert.equal(response.status, 201);
  const delivered = await stream.wait(message => message.type === 'roll');
  assert.deepEqual(delivered.data, response.value.roll);
  assert.equal(delivered.data.author, 'Alice');
  assert.equal(delivered.data.results.length, 3);
  assert.equal(stream.messages.filter(message => message.type === 'roll').length, 1);
  assert.equal((await bob.request('/api/rolls')).value.rolls[0].id, response.value.roll.id);
});

test('Only me results are absent from another player AND GM live packets, history, and reconnect snapshots', async t => {
  const { gm, alice, bob } = await party(t);
  const gmStream = await gm.stream(); const bobStream = await bob.stream(); const aliceStream = await alice.stream();
  const hidden = (await alice.request('/api/rolls', { expression: 'd20', visibility: 'private', label: 'secret-result-canary' })).value.roll;
  await aliceStream.wait(message => message.type === 'roll' && message.data.id === hidden.id);
  // A following public event is a delivery barrier on both other accounts' streams.
  const visible = (await alice.request('/api/rolls', { expression: 'd6', visibility: 'public' })).value.roll;
  for (const [account, stream] of [[gm, gmStream], [bob, bobStream]]) {
    await stream.wait(message => message.type === 'roll' && message.data.id === visible.id);
    assert.ok(!JSON.stringify(stream.messages).includes('secret-result-canary'));
    assert.ok(!JSON.stringify(stream.messages).includes(hidden.id));
    assert.ok(!(await account.request('/api/state')).value.rolls.some(roll => roll.id === hidden.id));
    assert.ok(!(await account.request('/api/rolls')).value.rolls.some(roll => roll.id === hidden.id));
    const reconnect = await account.stream();
    assert.ok(!JSON.stringify(reconnect.messages).includes(hidden.id));
  }
  assert.ok((await alice.request('/api/rolls')).value.rolls.some(roll => roll.id === hidden.id));
});

test('To GM rolls reach their author and GM, but never a third player', async t => {
  const { gm, alice, bob } = await party(t);
  const gmStream = await gm.stream(); const bobStream = await bob.stream();
  const secret = (await alice.request('/api/rolls', { expression: '2d6+4', visibility: 'gm', label: 'GM-only-canary' })).value.roll;
  await gmStream.wait(message => message.type === 'roll' && message.data.id === secret.id);
  const barrier = (await alice.request('/api/rolls', { expression: 'd6', visibility: 'public' })).value.roll;
  await bobStream.wait(message => message.type === 'roll' && message.data.id === barrier.id);
  assert.ok(!JSON.stringify(bobStream.messages).includes(secret.id));
  for (const account of [gm, alice]) assert.ok((await account.request('/api/rolls')).value.rolls.some(roll => roll.id === secret.id));
  assert.ok(!(await bob.request('/api/rolls')).value.rolls.some(roll => roll.id === secret.id));
});

test('rooms stay isolated even when a client supplies another room or role', async t => {
  const { client, alice } = await party(t);
  const other = client();
  await other.request('/api/rooms', { roomName: 'Another table', username: 'Other GM', password });
  const stream = await other.stream();
  const roll = (await alice.request('/api/rolls', { expression: 'd20', visibility: 'public', roomId: (await other.request('/api/state')).value.me.id, role: 'gm' })).value.roll;
  const barrier = (await other.request('/api/rolls', { expression: 'd6', visibility: 'public' })).value.roll;
  await stream.wait(message => message.type === 'roll' && message.data.id === barrier.id);
  assert.ok(!JSON.stringify(stream.messages).includes(roll.id));
  assert.ok(!(await other.request('/api/state')).value.rolls.some(item => item.id === roll.id));
});

test('logout revokes a session and closes its existing live stream', async t => {
  const { alice } = await party(t);
  const stream = await alice.stream();
  const cookie = alice.cookie;
  assert.equal((await alice.request('/api/logout', {})).status, 200);
  assert.equal((await alice.request('/api/state', undefined, { Cookie: cookie })).status, 401);
  await stream.close();
});

test('six seats maximum and case-insensitive names are enforced', async t => {
  const { client, roomCode } = await party(t);
  assert.equal((await client().request('/api/join', { roomCode, username: 'ALICE', password })).status, 409);
  for (const username of ['Carla', 'Doran', 'Erin']) assert.equal((await client().request('/api/join', { roomCode, username, password })).status, 201);
  assert.equal((await client().request('/api/join', { roomCode, username: 'Seventh', password })).status, 409);
});

test('origin checks, explicit visibility, and dice validation fail closed', async t => {
  const { alice, origin } = await party(t);
  const body = { expression: 'd20', visibility: 'public' };
  assert.equal((await alice.request('/api/rolls', body, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await alice.request('/api/rolls', body, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await alice.request('/api/rolls', { expression: 'd20' })).status, 400);
  assert.equal((await alice.request('/api/rolls', { ...body, visibility: 'unknown' })).status, 400);
  assert.equal((await alice.request('/api/rolls', { ...body, expression: '100000d20' })).status, 400);
  assert.equal((await alice.request('/api/rolls', { ...body, label: 'x'.repeat(81) })).status, 400);
  assert.deepEqual((await alice.request('/api/rolls')).value.rolls, []);
});

test('stored accounts and authorized history survive a server restart', async t => {
  mkdirSync(resolve('work'), { recursive: true });
  const directory = mkdtempSync(resolve('work/persistence-'));
  const databasePath = resolve(directory, 'tavern.sqlite');
  let app = createTavern({ databasePath });
  const start = async () => { await new Promise(done => app.server.listen(0, '127.0.0.1', done)); return `http://127.0.0.1:${app.server.address().port}`; };
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  let origin = await start();
  const send = async (path, body, cookie = '') => {
    const res = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0], body: await res.json() };
  };
  const created = await send('/api/rooms', { roomName: 'Persistent table', username: 'GM', password });
  const before = (await send('/api/state', null, created.cookie)).body;
  const rolled = await send('/api/rolls', { expression: '3d20', visibility: 'private' }, created.cookie);
  await app.close();
  app = createTavern({ databasePath }); origin = await start();
  const signedIn = await send('/api/login', { roomCode: before.room.code, username: 'GM', password });
  assert.equal(signedIn.status, 200);
  const after = (await send('/api/state', null, signedIn.cookie)).body;
  assert.equal(after.me.id, before.me.id);
  assert.deepEqual(after.rolls, [rolled.body.roll]);
});

test('static assets are served with restrictive headers; data files are never exposed', async t => {
  const { origin } = await fixture(t);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /The Tavern/);
  for (const path of ['/data/tavern.sqlite', '/server.mjs', '/.env', '/lib/dice.mjs']) assert.equal((await fetch(origin + path)).status, 404);
});

test('an expired open stream cannot receive a subsequent roll', async t => {
  const { client } = await fixture(t, { sessionAge: 200 });
  const account = client();
  await account.request('/api/rooms', { roomName: 'Expiry test', username: 'GM', password });
  const roomCode = (await account.request('/api/state')).value.room.code;
  const oldStream = await account.stream();
  await delay(250);
  assert.equal((await account.request('/api/state')).status, 401);
  assert.equal((await account.request('/api/login', { roomCode, username: 'GM', password })).status, 200);
  const fresh = await account.request('/api/rolls', { expression: 'd20', visibility: 'public' });
  assert.equal(fresh.status, 201);
  await oldStream.wait(message => message.type === 'expired');
  assert.ok(!JSON.stringify(oldStream.messages).includes(fresh.value.roll.id));
});

test('a configured HTTPS origin enables Secure cookies and rejects other origins', async t => {
  const appOrigin = 'https://tavern.example';
  const { client } = await fixture(t, { appOrigin });
  const account = client();
  const body = { roomName: 'Secure table', username: 'GM', password };
  assert.equal((await account.request('/api/rooms', body)).status, 403);
  const created = await account.request('/api/rooms', body, { Origin: appOrigin });
  assert.equal(created.status, 201);
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(created.headers.get('set-cookie').includes(flag));
  assert.equal(created.headers.get('strict-transport-security'), 'max-age=31536000');
});
