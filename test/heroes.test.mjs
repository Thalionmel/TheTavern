import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createTavern } from '../server.mjs';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { readHero } from '../lib/heroes.mjs';

const password = 'character-test-password';
const hero = JSON.stringify({ name: 'Arbosch', lastName: 'Test', attributes: { MU: 14, KL: 12, IN: 13, CH: 11, FF: 10, GE: 12, KO: 15, KK: 15 }, notes: '<img src=x onerror=alert(1)>', sheetDetails: { inventory: [{ name: 'Sword', quantity: 1 }] }, extension: 'preserve-me', padding: 'x'.repeat(140000) });
const pdf = Buffer.from(`%PDF-1.4\n${'0'.repeat(180000)}\n%%EOF`);
const uploadPath = (name, visibility = 'private') => `/api/hero?${new URLSearchParams({ name, visibility, ownerId: 'forged', role: 'gm' })}`;

for (const platform of ['Node', 'Cloudflare']) test(`${platform}: character attachments enforce audiences, room boundaries, replacement and sessions`, async t => {
  let dispatch, evict = async () => {};
  if (platform === 'Node') {
    const app = createTavern({ databasePath: ':memory:' });
    await new Promise(done => app.server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    dispatch = (path, options) => fetch(base + path, { ...options, headers: { Origin: base, ...options.headers } });
    t.after(() => app.close());
  } else {
    const mf = new Miniflare(convertV4MiniflareOptions({
      name: 'the-tavern', modules: true, scriptPath: resolve('work/cloudflare-build/worker.js'), compatibilityDate: '2026-11-11', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { CAMPAIGNS: { className: 'CampaignRoom', useSQLite: true }, REQUEST_GUARDS: { className: 'RequestGuard', useSQLite: true } },
      log: new Log(LogLevel.ERROR),
    }));
    await mf.ready; t.after(() => mf.dispose());
    dispatch = (path, options) => mf.dispatchFetch('https://tavern.example' + path, { ...options, headers: { Origin: 'https://tavern.example', ...options.headers } });
    evict = code => mf.unsafeEvictDurableObject('the-tavern', 'CampaignRoom', { name: code, webSockets: 'hibernate' });
  }
  function client() {
    let cookie = '';
    const request = async (path, body, mime, extra = {}) => {
      const response = await dispatch(path, { method: body === undefined ? 'GET' : 'POST', body, headers: { Cookie: cookie, ...(mime ? { 'Content-Type': mime } : {}), ...extra } });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return response;
    };
    return { request, json: async (path, body) => { const response = await request(path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json'); return { status: response.status, ...await response.json() }; } };
  }
  const gm = client(), alice = client(), bob = client(), outsider = client(), anonymous = client();
  assert.equal((await gm.json('/api/rooms', { roomName: 'Hero tests', username: 'GM', password })).status, 201);
  const code = (await gm.json('/api/state')).room.code;
  for (const [user, username] of [[alice, 'Alice'], [bob, 'Bob']]) assert.equal((await user.json('/api/join', { roomCode: code, username, password })).status, 201);
  assert.equal((await outsider.json('/api/rooms', { roomName: 'Other table', username: 'Outsider', password })).status, 201);
  const aliceId = (await alice.json('/api/state')).me.id;
  let previous;
  for (const [visibility, allowed] of [['private', [alice]], ['gm', [alice, gm]], ['public', [alice, gm, bob]]]) {
    const response = await alice.request(uploadPath('Hero.json', visibility), hero, 'application/json');
    assert.equal(response.status, 201, await response.clone().text());
    const { sheet } = await response.json();
    assert.equal(sheet.ownerId, aliceId);
    assert.equal(sheet.visibility, visibility);
    if (previous) assert.equal((await alice.request(`/api/heroes/${previous}`)).status, 404);
    previous = sheet.id;
    await evict(code);
    for (const viewer of [alice, gm, bob, outsider]) {
      const list = await viewer.json('/api/heroes');
      assert.equal(list.sheets.some(item => item.id === sheet.id), allowed.includes(viewer));
      const download = await viewer.request(`/api/heroes/${sheet.id}`);
      assert.equal(download.status, allowed.includes(viewer) ? 200 : 404);
      if (download.status === 200) { assert.equal(download.headers.get('cache-control'), 'no-store'); assert.equal(await download.text(), hero); }
    }
    assert.equal((await anonymous.request(`/api/heroes/${sheet.id}`)).status, 401);
  }
  const uploaded = await alice.request(uploadPath('Hero.pdf', 'gm'), pdf, 'application/pdf');
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const sheet = (await uploaded.json()).sheet;
  const download = await gm.request(`/api/heroes/${sheet.id}`);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
  assert.equal((await alice.request(uploadPath('Hero.pdf'), pdf, 'application/pdf', { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await anonymous.request(uploadPath('Hero.pdf'), pdf, 'application/pdf')).status, 401);
  assert.equal((await alice.request(uploadPath('Hero.pdf'), 'not-pdf', 'application/pdf')).status, 400);
  assert.deepEqual(Buffer.from(await (await alice.request(`/api/heroes/${sheet.id}`)).arrayBuffer()), pdf);
  assert.equal((await alice.request(uploadPath('Hero.pdf'), pdf, 'application/pdf')).status, 429);
  await alice.json('/api/logout', {});
  assert.equal((await alice.request(`/api/heroes/${sheet.id}`)).status, 401);
  assert.equal((await alice.json('/api/login', { roomCode: code, username: 'Alice', password })).status, 200);
  assert.equal((await alice.json('/api/heroes')).sheets[0].id, sheet.id);
});

test('Character upload reader bounds streaming bodies and validates PDF and Heldenbau data', async () => {
  const stream = bytes => (async function* () { yield bytes; })();
  const bytes = value => Buffer.from(value);
  await assert.rejects(readHero(stream(bytes('x')), 'text/html'), { status: 415 });
  for (const value of ['{}', '[]', '{"name":"Hero","attributes":{}}', 'not-json']) await assert.rejects(readHero(stream(bytes(value)), 'application/json'), { status: 400 });
  await assert.rejects(readHero(stream(bytes('%PDF-1.4')), 'application/pdf'), { status: 400 });
  await assert.rejects(readHero(stream(bytes(hero)), 'application/json', '3000000'), { status: 413 });
  await assert.rejects(readHero(stream(new Uint8Array(2 * 1024 * 1024 + 1)), 'application/json'), { status: 413 });
  await assert.rejects(readHero(stream(new Uint8Array(10 * 1024 * 1024 + 1)), 'application/pdf'), { status: 413 });
  assert.equal(new TextDecoder().decode((await readHero(stream(bytes(hero)), 'application/json')).bytes), hero);
});
