import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { encode, decode } from 'fast-png';
import jpeg from 'jpeg-js';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { createTavern } from '../server.mjs';
import { mapImage, readMap } from '../lib/maps.mjs';

const password = 'map-verification-password';
const fixtureImage = { width: 64, height: 64, channels: 4, data: new Uint8Array(64 * 64 * 4) };
for (let i = 0; i < 64 * 64; i++) fixtureImage.data.set([i % 251, i % 239, i % 227, 255], i * 4);
const png = encode({ ...fixtureImage, text: { Secret: 'GM-only-canary-metadata' } });
const path = map => `/api/map/image?id=${map.id}&version=${map.imageRevision}`;

for (const platform of ['Node', 'Cloudflare']) test(`${platform}: map pixels, fog, tokens and live notifications obey GM and campaign boundaries`, async t => {
  let dispatch, evict = async () => {}, websocket = false;
  if (platform === 'Node') {
    const app = createTavern({ databasePath: ':memory:' });
    await new Promise(done => app.server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    dispatch = (route, options) => fetch(origin + route, { ...options, headers: { Origin: origin, ...options.headers } });
    t.after(() => app.close());
  } else {
    const mf = new Miniflare(convertV4MiniflareOptions({ name: 'the-tavern', modules: true, scriptPath: resolve('work/cloudflare-build/worker.js'), compatibilityDate: '2026-11-11', compatibilityFlags: ['nodejs_compat'], durableObjects: { CAMPAIGNS: { className: 'CampaignRoom', useSQLite: true }, REQUEST_GUARDS: { className: 'RequestGuard', useSQLite: true } }, log: new Log(LogLevel.ERROR) }));
    await mf.ready; t.after(() => mf.dispose()); websocket = true;
    dispatch = (route, options) => mf.dispatchFetch('https://tavern.example' + route, { ...options, headers: { Origin: 'https://tavern.example', ...options.headers } });
    evict = code => mf.unsafeEvictDurableObject('the-tavern', 'CampaignRoom', { name: code, webSockets: 'hibernate' });
  }
  const clients = [];
  function client() {
    let cookie = '';
    const request = async (route, body, mime, extra = {}) => {
      const result = await dispatch(route, { method: body === undefined ? 'GET' : 'POST', body, headers: { Cookie: cookie, ...(mime ? { 'Content-Type': mime } : {}), ...extra } });
      if (result.headers.has('set-cookie')) cookie = result.headers.get('set-cookie').split(';')[0];
      return result;
    };
    const account = { request,
      async json(route, body, extra) { const response = await request(route, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json', extra); return { status: response.status, ...await response.json() }; },
      async stream() {
        const messages = [];
        if (websocket) {
          const response = await request('/api/events', undefined, undefined, { Upgrade: 'websocket' });
          assert.equal(response.status, 101); const socket = response.webSocket;
          socket.addEventListener('message', event => messages.push(JSON.parse(event.data))); socket.accept();
          t.after(() => { try { socket.close(); } catch {} });
        } else {
          const controller = new AbortController();
          const response = await dispatch('/api/events', { headers: { Cookie: cookie }, signal: controller.signal });
          t.after(() => controller.abort());
          (async () => { let buffered = ''; const decoder = new TextDecoder(); try { for await (const chunk of response.body) {
            buffered += decoder.decode(chunk, { stream: true }); let end;
            while ((end = buffered.indexOf('\n\n')) >= 0) { const event = buffered.slice(0, end); buffered = buffered.slice(end + 2); const type = event.match(/^event: (.+)$/m)?.[1], data = event.match(/^data: (.+)$/m)?.[1]; if (type && data) messages.push({ type, data: JSON.parse(data) }); }
          } } catch (err) { if (err.name !== 'AbortError') throw err; } })();
        }
        return { messages, async waitForMap(count = 1) { const until = Date.now() + 3000; while (messages.filter(item => item.type === 'map').length < count && Date.now() < until) await delay(10); assert.ok(messages.filter(item => item.type === 'map').length >= count); } };
      },
    }; clients.push(account); return account;
  }
  const gm = client(), alice = client(), bob = client(), outsider = client(), anonymous = client();
  await gm.json('/api/rooms', { roomName: 'Map test', username: 'GM', password });
  const code = (await gm.json('/api/state')).room.code;
  for (const [account, username] of [[alice, 'Alice'], [bob, 'Bob']]) await account.json('/api/join', { roomCode: code, username, password });
  await outsider.json('/api/rooms', { roomName: 'Other room', username: 'Other GM', password });
  const aliceId = (await alice.json('/api/state')).me.id, bobId = (await bob.json('/api/state')).me.id, outsiderId = (await outsider.json('/api/state')).me.id;
  const stream = await alice.stream();
  assert.equal((await alice.request('/api/map/upload?title=Forged&role=gm', png, 'image/png')).status, 403);
  const upload = await gm.request('/api/map/upload?title=Secret%20watchtower', png, 'image/png');
  assert.equal(upload.status, 201, await upload.clone().text()); let map = (await upload.json()).map;
  await stream.waitForMap();
  assert.deepEqual((await alice.json('/api/map')).map, null);
  assert.equal((await alice.request(path(map))).status, 404);
  const original = decode(new Uint8Array(await (await gm.request(path(map))).arrayBuffer()));
  assert.deepEqual(original.data, fixtureImage.data); assert.deepEqual(original.text, {});
  await evict(code);
  const action = async body => { const result = await gm.json('/api/map/action', { mapId: map.id, revision: map.revision, ...body }); if (result.status === 200) map = result.map; return result; };
  assert.equal((await action({ action: 'publish', published: true })).status, 200);
  let playerMap = (await alice.json('/api/map')).map;
  assert.equal('fog' in playerMap, false);
  const hidden = await alice.request(path(map) + '&source=gm&role=gm');
  assert.equal(hidden.headers.get('cache-control'), 'no-store');
  const hiddenPixels = decode(new Uint8Array(await hidden.arrayBuffer())).data;
  for (let i = 0; i < hiddenPixels.length; i += 4) assert.deepEqual([...hiddenPixels.subarray(i, i + 4)], [14, 25, 28, 255]);
  assert.equal((await outsider.request(path(map))).status, 404);
  assert.equal((await anonymous.request(path(map))).status, 401);
  assert.equal((await alice.json('/api/map/action', { mapId: map.id, revision: map.revision, action: 'reveal-all', role: 'gm' })).status, 403);
  const stale = map.revision;
  await action({ action: 'fog', mode: 'reveal', x: 0, y: 0, width: 16, height: 32 });
  const revealed = decode(new Uint8Array(await (await bob.request(path(map))).arrayBuffer()));
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const i = (y * 64 + x) * 4; assert.deepEqual([...revealed.data.subarray(i, i + 4)], x < 32 ? [...fixtureImage.data.subarray(i, i + 4)] : [14, 25, 28, 255]); }
  assert.equal((await gm.json('/api/map/action', { mapId: map.id, revision: stale, action: 'hide-all' })).status, 409);
  assert.equal((await alice.json('/api/map/action', { mapId: map.id, revision: map.revision, action: 'token', ownerId: bobId, x: .2, y: .5, role: 'gm' })).status, 403);
  assert.equal((await alice.json('/api/map/action', { mapId: map.id, revision: map.revision, action: 'token', ownerId: aliceId, x: .8, y: .5 })).status, 403);
  const moved = await alice.json('/api/map/action', { mapId: map.id, revision: map.revision, action: 'token', ownerId: aliceId, x: .2, y: .5 }); assert.equal(moved.status, 200); map = (await gm.json('/api/map')).map;
  await action({ action: 'token', ownerId: bobId, x: .8, y: .5 });
  assert.equal((await bob.json('/api/map')).map.tokens.some(token => token.ownerId === bobId), false);
  assert.equal(map.tokens.some(token => token.ownerId === bobId && token.concealed), true);
  assert.equal((await action({ action: 'token', ownerId: outsiderId, x: .2, y: .5 })).status, 400);
  for (const x of [-.1, 1, '0.5', null]) assert.equal((await action({ action: 'token', ownerId: aliceId, x, y: .5 })).status, 400);
  assert.equal((await action({ action: 'fog', mode: 'reveal', x: 31, y: 0, width: 2, height: 32 })).status, 400);
  await evict(code);
  assert.equal((await gm.json('/api/map')).map.tokens.length, 2);
  assert.equal((await action({ action: 'hide-all' })).status, 200);
  assert.deepEqual((await alice.json('/api/map')).map.tokens, []);
  const oldVersion = map.imageRevision;
  await action({ action: 'reveal-all' });
  assert.equal((await alice.request(`/api/map/image?id=${map.id}&version=${oldVersion}`)).status, 409);
  assert.deepEqual(decode(new Uint8Array(await (await alice.request(path(map))).arrayBuffer())).data, fixtureImage.data);
  assert.equal((await gm.json('/api/map/action', { mapId: map.id, revision: map.revision, action: 'hide-all' }, { Origin: 'https://attacker.example' })).status, 403);
  await action({ action: 'publish', published: false }); assert.equal((await alice.json('/api/map')).map, null); assert.equal((await alice.request(path(map))).status, 404);
  const wrongReplace = await gm.request('/api/map/upload?title=Wrong&replace=old', png, 'image/png'); assert.equal(wrongReplace.status, 409);
  const oldId = map.id;
  const replacement = await gm.request(`/api/map/upload?title=New&replace=${map.id}`, png, 'image/png'); assert.equal(replacement.status, 201); map = (await replacement.json()).map;
  assert.notEqual(map.id, oldId); assert.equal(map.published, false); assert.deepEqual(map.tokens, []); assert.equal(map.fog, '0'.repeat(1024));
  assert.equal((await gm.request(`/api/map/image?id=${oldId}&version=1`)).status, 404);
  await stream.waitForMap(9);
  assert.ok(stream.messages.filter(item => item.type === 'map').every(item => Object.keys(item.data).every(key => key === 'image')));
  await alice.json('/api/logout', {}); assert.equal((await alice.request('/api/map')).status, 401);
});

test('Map decoding bounds input, strips metadata and supports JPEG', async () => {
  const clean = mapImage(jpeg.encode(fixtureImage).data, 'image/jpeg'); assert.equal(clean.width, 64);
  const body = bytes => (async function* () { yield bytes; })();
  await assert.rejects(readMap(body(png), 'image/svg+xml'), { status: 415 });
  await assert.rejects(readMap(body(new Uint8Array(8 * 1024 * 1024 + 1)), 'image/png'), { status: 413 });
  await assert.rejects(readMap(body(png), 'image/png', '9000000'), { status: 413 });
  assert.throws(() => mapImage(new Uint8Array([1, 2, 3]), 'image/png'), { status: 400 });
  const huge = png.slice(); new DataView(huge.buffer).setUint32(16, 50000); assert.throws(() => mapImage(huge, 'image/png'), { status: 400 });
  const small = encode({ width: 1, height: 1, channels: 4, data: new Uint8Array([1, 2, 3, 255]) });
  const bomb = deflateSync(new Uint8Array(4 * 1024 * 1024)); const modified = new Uint8Array(33 + 12 + bomb.length + 12);
  modified.set(small.subarray(0, 33)); const view = new DataView(modified.buffer); view.setUint32(33, bomb.length); modified.set([73, 68, 65, 84], 37); modified.set(bomb, 41); modified.set(small.subarray(-12), modified.length - 12);
  assert.throws(() => mapImage(modified, 'image/png'), { status: 400 });
});
