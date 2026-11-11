import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rollDice } from './lib/dice.mjs';
import { HERO_SCHEMA, heroStore, readHero, heroHeaders } from './lib/heroes.mjs';
import { MAP_SCHEMA, mapStore, readMap } from './lib/maps.mjs';
import { DIARY_SCHEMA, DIARY_BODY_LIMIT, diaryStore } from './lib/diary.mjs';

const derive = promisify(scrypt);
const root = dirname(fileURLToPath(import.meta.url));
const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
const VISIBILITIES = new Set(['public', 'private', 'gm']);
const hash = value => createHash('sha256').update(value).digest('hex');
const error = (status, message) => Object.assign(new Error(message), { status });

async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

async function passwordMatches(password, stored) {
  const [salt, encoded] = stored.split(':');
  const key = await derive(password, salt, 64);
  return timingSafeEqual(key, Buffer.from(encoded, 'hex'));
}

function accountFields(body) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = body.password;
  if (!/^[\p{L}\p{N} _-]{2,32}$/u.test(username)) throw error(400, 'Use a name with 2–32 letters, numbers, spaces, dashes or underscores.');
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw error(400, 'Choose a password with 10–128 characters.');
  return { username, usernameKey: username.toLowerCase(), password };
}

async function readJson(req, limit = 8192) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw error(415, 'Send application/json.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > limit) throw error(413, 'That request is too large.');
    chunks.push(chunk);
  }
  try {
    const text = Buffer.concat(chunks, size).toString('utf8');
    const body = JSON.parse(text);
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw error(400, 'Send a valid JSON object.'); }
}

export function createTavern({ databasePath = resolve(root, 'data/tavern.sqlite'), appOrigin = '', sessionAge = SESSION_AGE } = {}) {
  if (appOrigin) {
    const parsed = new URL(appOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== appOrigin) throw new Error('APP_ORIGIN must be an exact http(s) origin without a trailing slash.');
  }
  if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), username TEXT NOT NULL,
      username_key TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('gm','player')),
      UNIQUE(room_id, username_key)
    );
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rolls (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      room_id TEXT NOT NULL REFERENCES rooms(id), author_id TEXT NOT NULL REFERENCES accounts(id),
      visibility TEXT NOT NULL CHECK(visibility IN ('public','private','gm')), label TEXT NOT NULL,
      expression TEXT NOT NULL, results TEXT NOT NULL, modifier INTEGER NOT NULL, total INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rolls_room ON rolls(room_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
  `);
  for (const statement of [...HERO_SCHEMA, ...MAP_SCHEMA, ...DIARY_SCHEMA]) db.exec(statement);
  const database = {
    query: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    transaction: fn => { db.exec('BEGIN IMMEDIATE'); try { fn(); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; } },
  };
  const heroes = heroStore(database);
  const diary = diaryStore(database);
  const maps = mapStore({ ...database, memberFor: (account, id) => db.prepare('SELECT id FROM accounts WHERE id = ? AND room_id = ?').get(id, account.room_id) });
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
  const streams = new Set();
  const attempts = new Map();
  const files = new Map([
    ['/', ['text/html; charset=utf-8', readFileSync(resolve(root, 'public/index.html'))]],
    ['/app.js', ['text/javascript; charset=utf-8', readFileSync(resolve(root, 'public/app.js'))]],
    ['/dice3d.js', ['text/javascript; charset=utf-8', readFileSync(resolve(root, 'public/dice3d.js'))]],
    ['/dice3d.js.LEGAL.txt', ['text/plain; charset=utf-8', readFileSync(resolve(root, 'public/dice3d.js.LEGAL.txt'))]],
    ['/pdf-preview.js', ['text/javascript; charset=utf-8', readFileSync(resolve(root, 'public/pdf-preview.js'))]],
    ['/diary.js', ['text/javascript; charset=utf-8', readFileSync(resolve(root, 'public/diary.js'))]],
    ['/maps.js', ['text/javascript; charset=utf-8', readFileSync(resolve(root, 'public/maps.js'))]],
    ['/heroes.js', ['text/javascript; charset=utf-8', readFileSync(resolve(root, 'public/heroes.js'))]],
    ['/styles.css', ['text/css; charset=utf-8', readFileSync(resolve(root, 'public/styles.css'))]],
    ['/favicon.svg', ['image/svg+xml', readFileSync(resolve(root, 'public/favicon.svg'))]],
  ]);

  // Only generated PDF support files are added, never arbitrary filesystem paths.
  for (const entry of readdirSync(resolve(root, 'public/pdfjs'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = resolve(entry.parentPath, entry.name);
    const relative = path.slice(resolve(root, 'public').length).replaceAll('\\', '/');
    files.set(relative, [entry.name.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'application/octet-stream', readFileSync(path)]);
  }

  function rateLimit(req, bucket, limit, windowMs) {
    const key = `${bucket}:${req.socket.remoteAddress}`;
    const now = Date.now();
    const record = attempts.get(key);
    if (!record || now >= record.until) { attempts.set(key, { count: 1, until: now + windowMs }); return; }
    if (++record.count > limit) throw error(429, 'A little too fast. Please wait a moment and try again.');
  }

  function authenticate(req) {
    const cookie = (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith('tavern_session='));
    const token = cookie?.slice('tavern_session='.length);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw error(401, 'Please sign in to your room.');
    const tokenHash = hash(token);
    const account = db.prepare(`SELECT a.id, a.room_id, a.username, a.role, s.expires
      FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires > ?`).get(tokenHash, Date.now());
    if (!account) throw error(401, 'Your session has ended. Please sign in again.');
    return { ...account, tokenHash };
  }

  function issueSession(res, accountId) {
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), accountId, Date.now() + sessionAge);
    const secure = appOrigin.startsWith('https://') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `tavern_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionAge / 1000)}${secure}`);
  }

  const serializeRoll = row => ({
    id: row.id, authorId: row.author_id, author: row.author, visibility: row.visibility,
    label: row.label, expression: row.expression, results: JSON.parse(row.results), modifier: row.modifier,
    total: row.total, createdAt: row.created_at,
  });
  const canSee = (roll, viewer) => roll.visibility === 'public' || roll.author_id === viewer.id || (roll.visibility === 'gm' && viewer.role === 'gm');

  function visibleHistory(account) {
    // Filter in the database BEFORE pagination; unauthorized records never leave the server.
    return db.prepare(`SELECT r.*, a.username AS author FROM rolls r JOIN accounts a ON a.id = r.author_id
      WHERE r.room_id = ? AND (r.visibility = 'public' OR r.author_id = ? OR (r.visibility = 'gm' AND ? = 'gm'))
      ORDER BY r.sequence DESC LIMIT 100`).all(account.room_id, account.id, account.role).reverse().map(serializeRoll);
  }

  function state(account) {
    const room = db.prepare('SELECT name, code FROM rooms WHERE id = ?').get(account.room_id);
    const online = new Set([...streams].filter(s => s.account.room_id === account.room_id && s.account.expires > Date.now()).map(s => s.account.id));
    const members = db.prepare('SELECT id, username AS name, role FROM accounts WHERE room_id = ? ORDER BY role, username').all(account.room_id)
      .map(member => ({ ...member, online: online.has(member.id) }));
    return { me: { id: account.id, name: account.username, role: account.role }, room, members, rolls: visibleHistory(account) };
  }

  function send(stream, type, data) {
    if (stream.res.destroyed) return;
    if (stream.account.expires <= Date.now()) {
      stream.res.write('event: expired\ndata: {}\n\n');
      stream.res.end();
      return;
    }
    if (stream.res.writableLength > 256 * 1024) { stream.res.destroy(); return; }
    stream.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function presence(roomId) {
    const online = [...new Set([...streams].filter(s => s.account.room_id === roomId && s.account.expires > Date.now()).map(s => s.account.id))];
    for (const stream of streams) if (stream.account.room_id === roomId) send(stream, 'presence', { online });
  }

  function mapChanged(roomId, image = true) { for (const stream of streams) if (stream.account.room_id === roomId) send(stream, 'map', { image }); }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; font-src 'self' blob:; frame-src 'self' blob: https://rpg-projects.vercel.app; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (appOrigin.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && files.has(url.pathname)) {
        const [type, body] = files.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(body); return;
      }
      if (req.method === 'GET' && url.pathname === '/healthz') { json(200, { status: 'ok' }); return; }
      if (!url.pathname.startsWith('/api/')) throw error(404, 'Not found.');
      if (req.method === 'POST') {
        const expected = appOrigin || `http://${req.headers.host}`;
        if (req.headers.origin !== expected || req.headers['sec-fetch-site'] === 'cross-site') throw error(403, 'This request must come from The Tavern.');
      } else if (req.method !== 'GET') throw error(405, 'Method not allowed.');

      if (req.method === 'POST' && ['/api/rooms', '/api/join', '/api/login'].includes(url.pathname)) {
        rateLimit(req, 'auth', 30, 60_000);
        const body = await readJson(req);
        const { username, usernameKey, password } = accountFields(body);
        if (url.pathname === '/api/rooms') {
          const name = typeof body.roomName === 'string' ? body.roomName.trim() : '';
          if (name.length < 2 || name.length > 64) throw error(400, 'Give your campaign a name with 2–64 characters.');
          const passwordEncoded = await passwordHash(password);
          const roomId = randomUUID();
          const accountId = randomUUID();
          const code = randomBytes(8).toString('hex').toUpperCase();
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('INSERT INTO rooms VALUES (?, ?, ?)').run(roomId, code, name);
            db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)').run(accountId, roomId, username, usernameKey, passwordEncoded, 'gm');
            db.exec('COMMIT');
          } catch (err) { db.exec('ROLLBACK'); throw err; }
          issueSession(res, accountId);
          json(201, { ok: true }); return;
        }
        const code = typeof body.roomCode === 'string' ? body.roomCode.trim().toUpperCase() : '';
        const room = db.prepare('SELECT id FROM rooms WHERE code = ?').get(code);
        if (url.pathname === '/api/login') {
          const account = room && db.prepare('SELECT id, password_hash FROM accounts WHERE room_id = ? AND username_key = ?').get(room.id, usernameKey);
          // Do the same expensive work for missing users to avoid an account timing oracle.
          const fallback = `${'0'.repeat(32)}:${'0'.repeat(128)}`;
          const matches = await passwordMatches(password, account?.password_hash ?? fallback);
          if (!account || !matches) throw error(401, 'The room code, name or password does not match.');
          issueSession(res, account.id);
          json(200, { ok: true }); return;
        }
        if (!room) throw error(404, 'That invitation code was not found.');
        const encoded = await passwordHash(password);
        const accountId = randomUUID();
        db.exec('BEGIN IMMEDIATE');
        try {
          if (db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE room_id = ?').get(room.id).count >= 6) throw error(409, 'This table already has six accounts.');
          if (db.prepare('SELECT id FROM accounts WHERE room_id = ? AND username_key = ?').get(room.id, usernameKey)) throw error(409, 'That name is already taken in this room. Sign in or choose another name.');
          db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?)').run(accountId, room.id, username, usernameKey, encoded, 'player');
          db.exec('COMMIT');
        } catch (err) { db.exec('ROLLBACK'); throw err; }
        issueSession(res, accountId);
        for (const stream of streams) if (stream.account.room_id === room.id) send(stream, 'members', { members: state(stream.account).members });
        json(201, { ok: true }); return;
      }

      const account = authenticate(req);
      if (url.pathname === '/api/diary' && req.method === 'GET') { json(200, diary.list(account, url)); return; }
      if (url.pathname.startsWith('/api/diary/') && req.method === 'GET') { json(200, { entry: diary.get(account, url.pathname.slice('/api/diary/'.length)) }); return; }
      if ((url.pathname === '/api/diary' || url.pathname.startsWith('/api/diary/')) && req.method === 'POST') {
        diary.limit(account);
        const body = await readJson(req, DIARY_BODY_LIMIT);
        const entry = url.pathname === '/api/diary' ? diary.create(account, body) : diary.update(account, url.pathname.slice('/api/diary/'.length), body);
        for (const stream of streams) if (stream.account.room_id === account.room_id) send(stream, 'diary', { id: entry.id, revision: entry.revision });
        json(url.pathname === '/api/diary' ? 201 : 200, { entry }); return;
      }
      if (url.pathname === '/api/map' && req.method === 'GET') { json(200, maps.state(account)); return; }
      if (url.pathname === '/api/map/image' && req.method === 'GET') {
        const image = maps.image(account, url); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(image); return;
      }
      if (url.pathname === '/api/map/upload' && req.method === 'POST') {
        maps.requireGM(account); maps.limit(account, 'upload');
        const image = await readMap(req, req.headers['content-type'], req.headers['content-length']);
        authenticate(req);
        const result = maps.upload(account, url, image); mapChanged(account.room_id); json(201, result); return;
      }
      if (url.pathname === '/api/map/action' && req.method === 'POST') {
        const body = await readJson(req); maps.limit(account, body.action === 'token' ? 'token' : 'fog');
        const result = maps.update(account, body); mapChanged(account.room_id, body.action !== 'token'); json(200, result); return;
      }
      if (url.pathname === '/api/heroes' && req.method === 'GET') { json(200, { sheets: heroes.list(account) }); return; }
      if (url.pathname === '/api/hero' && req.method === 'POST') {
        heroes.begin(account);
        const file = await readHero(req, req.headers['content-type'], req.headers['content-length']);
        authenticate(req);
        json(201, { sheet: heroes.save(account, url, file) }); return;
      }
      if (url.pathname.startsWith('/api/heroes/') && req.method === 'GET') {
        const sheet = heroes.get(account, url.pathname.slice('/api/heroes/'.length));
        res.writeHead(200, heroHeaders(sheet)); res.end(sheet.bytes); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') { json(200, state(account)); return; }
      if (req.method === 'GET' && url.pathname === '/api/rolls') { json(200, { rolls: visibleHistory(account) }); return; }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        await readJson(req);
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(account.tokenHash);
        for (const stream of [...streams]) if (stream.account.tokenHash === account.tokenHash) { streams.delete(stream); stream.res.end(); }
        presence(account.room_id);
        res.setHeader('Set-Cookie', 'tavern_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        json(200, { ok: true }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/rolls') {
        rateLimit(req, `roll:${account.id}`, 60, 60_000);
        const body = await readJson(req);
        if (!VISIBILITIES.has(body.visibility)) throw error(400, 'Choose Public, Only me, or To GM.');
        if (typeof body.label !== 'undefined' && (typeof body.label !== 'string' || body.label.length > 80)) throw error(400, 'Keep your roll label under 80 characters.');
        let rolled;
        try { rolled = rollDice(body.expression); } catch (err) { throw error(400, err.message); }
        const roll = { id: randomUUID(), author_id: account.id, author: account.username, visibility: body.visibility, label: (body.label ?? '').trim(), ...rolled, created_at: new Date().toISOString() };
        db.prepare(`INSERT INTO rolls (id, room_id, author_id, visibility, label, expression, results, modifier, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(roll.id, account.room_id, account.id, roll.visibility, roll.label, roll.expression, JSON.stringify(roll.results), roll.modifier, roll.total, roll.created_at);
        const serialized = serializeRoll({ ...roll, results: JSON.stringify(roll.results) });
        for (const stream of streams) if (stream.account.room_id === account.room_id && canSee(roll, stream.account)) send(stream, 'roll', serialized);
        json(201, { roll: serialized }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if ([...streams].filter(s => s.account.id === account.id).length >= 5) throw error(429, 'Please close another tab before opening this room again.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        const stream = { account, res };
        streams.add(stream);
        send(stream, 'snapshot', state(account));
        presence(account.room_id);
        req.on('close', () => { streams.delete(stream); presence(account.room_id); });
        return;
      }
      throw error(404, 'Not found.');
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (!err.status) console.error('Request failed:', err.message);
      json(err.status ?? 500, { error: err.status ? err.message : 'Something went wrong. Please try again.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
    db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
    for (const stream of streams) send(stream, 'heartbeat', { at: now });
  }, 15_000);
  heartbeat.unref();

  return {
    server,
    async close() {
      clearInterval(heartbeat);
      for (const stream of streams) stream.res.end();
      streams.clear();
      await new Promise((done, reject) => server.close(err => err ? reject(err) : done()));
      db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createTavern({ databasePath: resolve(process.env.DATABASE_PATH || resolve(root, 'data/tavern.sqlite')), appOrigin: process.env.APP_ORIGIN || '' });
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, host, () => console.log(`The Tavern is ready at ${process.env.APP_ORIGIN || `http://${host}:${port}`}`));
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; app.close().then(() => process.exit(0)); } };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
