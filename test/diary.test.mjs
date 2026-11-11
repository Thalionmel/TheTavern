import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { createTavern } from '../server.mjs';

const password = 'diary-verification-password';
const draft = (extra = {}) => ({ requestId: randomUUID(), title: 'An unexpected ally', body: 'The party reached the old watchtower.', eventDate: '2026-11-11', aventurianDate: '12. Praios 1047 BF', ...extra });

async function fixture(t, platform) {
  let dispatch, evict = async () => {}, websocket = platform === 'Cloudflare';
  if (!websocket) {
    const app = createTavern({ databasePath: ':memory:' }); await new Promise(done => app.server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    dispatch = (path, options) => fetch(origin + path, { ...options, headers: { Origin: origin, ...options.headers } }); t.after(() => app.close());
  } else {
    const mf = new Miniflare(convertV4MiniflareOptions({ name: 'the-tavern', modules: true, scriptPath: resolve('work/cloudflare-build/worker.js'), compatibilityDate: '2026-11-11', compatibilityFlags: ['nodejs_compat'], durableObjects: { CAMPAIGNS: { className: 'CampaignRoom', useSQLite: true }, REQUEST_GUARDS: { className: 'RequestGuard', useSQLite: true } }, log: new Log(LogLevel.ERROR) }));
    await mf.ready; t.after(() => mf.dispose());
    dispatch = (path, options) => mf.dispatchFetch('https://tavern.example' + path, { ...options, headers: { Origin: 'https://tavern.example', ...options.headers } });
    evict = code => mf.unsafeEvictDurableObject('the-tavern', 'CampaignRoom', { name: code, webSockets: 'hibernate' });
  }
  function client() {
    let cookie = '';
    const request = async (path, body, extra = {}) => {
      const response = await dispatch(path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra } });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, headers: response.headers, ...await response.json() };
    };
    return { request,
      async stream() {
        const messages = [];
        if (websocket) {
          const response = await dispatch('/api/events', { headers: { Cookie: cookie, Upgrade: 'websocket' } }); assert.equal(response.status, 101);
          const socket = response.webSocket; socket.addEventListener('message', event => messages.push(JSON.parse(event.data))); socket.accept(); t.after(() => { try { socket.close(); } catch {} });
        } else {
          const controller = new AbortController(); const response = await dispatch('/api/events', { headers: { Cookie: cookie }, signal: controller.signal }); t.after(() => controller.abort());
          (async () => { const decoder = new TextDecoder(); let buffered = ''; try { for await (const chunk of response.body) {
            buffered += decoder.decode(chunk, { stream: true }); let end;
            while ((end = buffered.indexOf('\n\n')) >= 0) { const event = buffered.slice(0, end); buffered = buffered.slice(end + 2); const type = event.match(/^event: (.+)$/m)?.[1], value = event.match(/^data: (.+)$/m)?.[1]; if (type && value) messages.push({ type, data: JSON.parse(value) }); }
          } } catch (err) { if (err.name !== 'AbortError') throw err; } })();
        }
        return { messages, async wait(id, revision) { const until = Date.now() + 3000; while (Date.now() < until) { const found = messages.find(item => item.type === 'diary' && item.data.id === id && item.data.revision === revision); if (found) return found; await delay(10); } assert.fail('Expected live diary notification did not arrive.'); } };
      },
    };
  }
  const gm = client(), alice = client(), bob = client(), outsider = client(), anonymous = client();
  await gm.request('/api/rooms', { roomName: 'Shared diary test', username: 'GM', password }); const code = (await gm.request('/api/state')).room.code;
  for (const [account, username] of [[alice, 'Alice'], [bob, 'Bob']]) await account.request('/api/join', { roomCode: code, username, password });
  await outsider.request('/api/rooms', { roomName: 'Other diary', username: 'Other GM', password });
  return { gm, alice, bob, outsider, anonymous, evict: () => evict(code) };
}

test('Node: a diary entry preserves UTF-8 characters split across request chunks', async t => {
  const app = createTavern({ databasePath: ':memory:' });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done)); t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const created = await fetch(origin + '/api/rooms', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ roomName: 'UTF-8 diary', username: 'Author', password }) });
  const cookie = created.headers.get('set-cookie').split(';')[0], data = draft({ body: 'A journey: 旅🌟' }), bytes = Buffer.from(JSON.stringify(data));
  const split = bytes.indexOf(Buffer.from('旅')) + 1;
  const response = await new Promise((done, reject) => {
    const req = httpRequest(origin + '/api/diary', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => done({ status: res.statusCode, ...JSON.parse(Buffer.concat(chunks).toString('utf8')) })); });
    req.on('error', reject); req.write(bytes.subarray(0, split)); setTimeout(() => req.end(bytes.subarray(split)), 5);
  });
  assert.equal(response.status, 201); assert.equal(response.entry.body, data.body);
});

for (const platform of ['Node', 'Cloudflare']) {
  test(`${platform}: shared diary authorship, live edits, conflicts and reversible archives stay within the campaign`, async t => {
    const { gm, alice, bob, outsider, anonymous, evict } = await fixture(t, platform);
    const [a, b, g, other] = await Promise.all([alice.stream(), bob.stream(), gm.stream(), outsider.stream()]);
    const data = draft({ body: '漢'.repeat(5989) + '<b>text</b>', authorId: 'forged', role: 'gm', editorId: 'forged' });
    const created = await alice.request('/api/diary', data); assert.equal(created.status, 201, JSON.stringify(created)); let entry = created.entry;
    assert.equal(entry.author, 'Alice'); assert.equal(entry.editor, 'Alice'); assert.equal(entry.body, data.body);
    for (const stream of [a, b, g]) await stream.wait(entry.id, 1);
    const retry = await alice.request('/api/diary', { ...data, requestId: data.requestId.toUpperCase() }); assert.equal(retry.entry.id, entry.id);
    assert.equal((await alice.request('/api/diary')).total, 1);
    assert.equal((await alice.request('/api/diary', { ...data, body: 'Different retry' })).status, 409);
    assert.equal((await bob.request(`/api/diary/${entry.id}`)).entry.canEdit, false);
    assert.equal((await gm.request(`/api/diary/${entry.id}`)).entry.canEdit, true);
    assert.equal((await outsider.request(`/api/diary/${entry.id}`)).status, 404); assert.equal((await outsider.request('/api/diary')).total, 0);
    assert.equal((await outsider.request(`/api/diary/${entry.id}`, { action: 'archive', revision: 1 })).status, 404);
    assert.equal((await anonymous.request('/api/diary')).status, 401); assert.equal((await anonymous.request('/api/diary', draft())).status, 401);
    assert.equal((await bob.request(`/api/diary/${entry.id}`, { ...draft(), action: 'edit', revision: 1, role: 'gm', authorId: entry.authorId })).status, 403);
    const updated = await gm.request(`/api/diary/${entry.id}`, { ...draft({ title: 'A correction from the GM', body: '<script>never execute</script>' }), action: 'edit', revision: 1 }); assert.equal(updated.status, 200); entry = updated.entry;
    assert.equal(entry.author, 'Alice'); assert.equal(entry.editor, 'GM'); assert.equal(entry.revision, 2); await b.wait(entry.id, 2);
    const stale = await alice.request(`/api/diary/${entry.id}`, { ...draft({ title: 'Outdated draft' }), action: 'edit', revision: 1 }); assert.equal(stale.status, 409);
    assert.equal((await alice.request(`/api/diary/${entry.id}`)).entry.title, entry.title);
    await evict();
    const archived = await alice.request(`/api/diary/${entry.id}`, { action: 'archive', revision: 2 }); assert.equal(archived.status, 200); assert.equal(archived.entry.archived, true); await g.wait(entry.id, 3);
    assert.equal((await bob.request('/api/diary')).total, 0); assert.equal((await bob.request('/api/diary?archived=1')).total, 1);
    assert.equal((await bob.request(`/api/diary/${entry.id}`, { action: 'restore', revision: 3 })).status, 403);
    assert.equal((await alice.request(`/api/diary/${entry.id}`, { ...draft(), action: 'edit', revision: 3 })).status, 409);
    const restored = await gm.request(`/api/diary/${entry.id}`, { action: 'restore', revision: 3 }); assert.equal(restored.status, 200); assert.equal(restored.entry.body, entry.body); await b.wait(entry.id, 4);
    const snapshot = await bob.request('/api/diary'); assert.equal(snapshot.entries[0].revision, 4); assert.equal('body' in snapshot.entries[0], false);
    assert.equal((await alice.request('/api/diary', draft(), { Origin: 'https://attacker.example' })).status, 403);
    assert.equal(other.messages.some(item => item.type === 'diary'), false);
    assert.ok(b.messages.filter(item => item.type === 'diary').every(item => Object.keys(item.data).sort().join(',') === 'id,revision'));
    await bob.request('/api/logout', {}); assert.equal((await bob.request(`/api/diary/${entry.id}`)).status, 401);
  });

  test(`${platform}: diary search, chronological pagination, validation and persisted rate bounds`, async t => {
    const { gm, alice, bob, evict } = await fixture(t, platform);
    const invalid = [{ eventDate: '2026-02-30' }, { eventDate: '2026-2-1' }, { eventDate: '0000-01-01' }, { title: ' ' }, { body: '' }, { body: 'x'.repeat(6001) }, { aventurianDate: 'x'.repeat(81) }, { requestId: 'invalid' }];
    for (const extra of invalid) assert.equal((await gm.request('/api/diary', draft(extra))).status, 400);
    assert.equal((await gm.request('/api/diary', draft({ body: 'x'.repeat(40000) }))).status, 413);
    assert.equal((await gm.request('/api/rolls', { expression: 'd20', visibility: 'public', padding: 'x'.repeat(9000) })).status, 413);
    const clients = [alice, bob, gm];
    for (let i = 0; i < 51; i++) assert.equal((await clients[i % 3].request('/api/diary', draft({ title: `Event ${i}`, eventDate: i === 50 ? '2020-01-01' : '2026-11-11', body: i === 0 ? 'Literal 100%_word and watchtower' : `Story ${i}` }))).status, 201);
    const first = await bob.request('/api/diary'); assert.equal(first.total, 51); assert.equal(first.entries.length, 50); assert.equal(first.pages, 2);
    const second = await bob.request('/api/diary?page=2'); assert.equal(second.entries.length, 1); assert.equal(second.entries[0].eventDate, '2020-01-01'); assert.equal(first.entries.some(entry => entry.id === second.entries[0].id), false);
    assert.equal((await bob.request('/api/diary?search=100%25_word')).total, 1);
    assert.equal((await bob.request('/api/diary?search=WATCHTOWER')).total, 1);
    assert.equal((await bob.request('/api/diary?search=Praios')).total, 51);
    assert.equal((await bob.request('/api/diary?page=9999')).page, 2);
    assert.equal((await bob.request('/api/diary?page=-1')).status, 400);
    assert.equal((await bob.request('/api/diary?archived=secret')).status, 400);
    await evict();
    const repeat = draft(); let limited = false;
    for (let i = 0; i < 31; i++) { const response = await alice.request('/api/diary', repeat); if (response.status === 429) { limited = true; break; } assert.equal(response.status, 201); }
    assert.ok(limited); assert.equal((await bob.request('/api/diary')).status, 200);
  });
}
