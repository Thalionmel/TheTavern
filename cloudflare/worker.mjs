import { DurableObject } from 'cloudflare:workers';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { rollDice } from '../lib/dice.mjs';
import { HERO_SCHEMA, heroStore, readHero, heroHeaders } from '../lib/heroes.mjs';
import { MAP_SCHEMA, mapStore, readMap } from '../lib/maps.mjs';
import { DIARY_SCHEMA, DIARY_BODY_LIMIT, diaryStore } from '../lib/diary.mjs';

const derive = promisify(scrypt);
const DAY = 86_400_000;
const audiences = new Set(['public', 'private', 'gm']);
const authPaths = new Set(['/api/rooms', '/api/join', '/api/login']);
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = value => createHash('sha256').update(value).digest('hex');
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};
const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });

function sessionCookie(request) {
  const value = (request.headers.get('Cookie') ?? '').split(';').map(x => x.trim()).find(x => x.startsWith('tavern_session='))?.slice(15);
  const match = value?.match(/^([A-F0-9]{16})\.([a-f0-9]{64})$/);
  return match ? { roomCode: match[1], tokenHash: hash(match[2]) } : null;
}

async function readBody(request, limit = 8192) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw fail(415, 'Send application/json.');
  if (!request.body) throw fail(400, 'Send a valid JSON object.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw fail(413, 'That request is too large.'); }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw fail(400, 'Send a valid JSON object.'); }
}

function credentials(body) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!/^[\p{L}\p{N} _-]{2,32}$/u.test(username)) throw fail(400, 'Use a name with 2–32 letters, numbers, spaces, dashes or underscores.');
  if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) throw fail(400, 'Choose a password with 10–128 characters.');
  return { username, usernameKey: username.toLowerCase(), password: body.password };
}

async function encodePassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

async function checkPassword(password, stored) {
  const [salt, encoded] = (stored ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`).split(':');
  const key = await derive(password, salt, 64);
  return timingSafeEqual(key, Buffer.from(encoded, 'hex'));
}

function errorResponse(error) {
  if (!error.status) console.error('Request failed:', error.message);
  return json(error.status ?? 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/healthz' && request.method === 'GET') return json(200, { status: 'ok', platform: 'cloudflare' });
      if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
      if (!['GET', 'POST'].includes(request.method)) throw fail(405, 'Method not allowed.');
      const isSocket = path === '/api/events';
      if (request.method === 'POST' || isSocket) {
        if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
          throw fail(403, 'This request must come from The Tavern.');
        }
      }
      let body;
      let roomCode;
      if (request.method === 'POST' && authPaths.has(path)) {
        const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
        const guard = env.REQUEST_GUARDS.get(env.REQUEST_GUARDS.idFromName(ip));
        if (!await guard.allow(path === '/api/rooms' ? 'create' : 'auth', path === '/api/rooms' ? 10 : 30)) {
          throw fail(429, 'A little too fast. Please wait a moment and try again.');
        }
        body = await readBody(request);
        credentials(body);
        roomCode = path === '/api/rooms' ? randomBytes(8).toString('hex').toUpperCase() : String(body.roomCode ?? '').trim().toUpperCase();
        if (!/^[A-F0-9]{16}$/.test(roomCode)) throw fail(path === '/api/login' ? 401 : 404, path === '/api/login' ? 'The room code, name or password does not match.' : 'That invitation code was not found.');
      } else {
        const session = sessionCookie(request);
        if (!session) throw fail(401, 'Please sign in to your room.');
        roomCode = session.roomCode;
        if (request.method === 'POST' && !['/api/hero', '/api/map/upload'].includes(path)) body = await readBody(request, path === '/api/diary' || path.startsWith('/api/diary/') ? DIARY_BODY_LIMIT : 8192);
      }
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.delete('Content-Length');
      forwardHeaders.set('X-Tavern-Room', roomCode);
      const forwarded = new Request(request.url, { method: request.method, headers: forwardHeaders, body: ['/api/hero', '/api/map/upload'].includes(path) && request.method === 'POST' ? request.body : body === undefined ? undefined : JSON.stringify(body) });
      return await env.CAMPAIGNS.get(env.CAMPAIGNS.idFromName(roomCode)).fetch(forwarded);
    } catch (error) { return errorResponse(error); }
  },
};

// A tiny per-IP guard preserves rate limits across room creation and hibernation.
// No intervals, alarms or continuously running processes are needed.
export class RequestGuard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL)');
  }
  allow(bucket, limit) {
    const now = Date.now();
    const row = this.sql.exec('SELECT count, until FROM limits WHERE bucket = ?', bucket).toArray()[0];
    if (!row || row.until <= now) {
      this.sql.exec('INSERT OR REPLACE INTO limits VALUES (?, 1, ?)', bucket, now + 60_000);
      return true;
    }
    if (row.count >= limit) return false;
    this.sql.exec('UPDATE limits SET count = count + 1 WHERE bucket = ?', bucket);
    return true;
  }
}

export class CampaignRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ttl = Number(env.SESSION_TTL_MS ?? 7 * DAY);
    if (!Number.isFinite(this.ttl) || this.ttl <= 0 || this.ttl > 7 * DAY) throw new Error('Invalid session lifetime.');
    ctx.blockConcurrencyWhile(async () => {
      for (const statement of [
        'CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK(id = 1), code TEXT NOT NULL, name TEXT NOT NULL)',
        `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('gm','player')))`,
        'CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL)',
        `CREATE TABLE IF NOT EXISTS rolls (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, author_id TEXT NOT NULL REFERENCES accounts(id), visibility TEXT NOT NULL CHECK(visibility IN ('public','private','gm')), label TEXT NOT NULL, expression TEXT NOT NULL, results TEXT NOT NULL, modifier INTEGER NOT NULL, total INTEGER NOT NULL, created_at TEXT NOT NULL)`,
        'CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id)',
        'CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires)',
        'CREATE TABLE IF NOT EXISTS roll_limits (account_id TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL)',
        ...HERO_SCHEMA, ...MAP_SCHEMA, ...DIARY_SCHEMA,
      ]) this.sql.exec(statement);
    });
    const database = { query: (sql, ...args) => this.sql.exec(sql, ...args).toArray(), run: (sql, ...args) => this.sql.exec(sql, ...args), transaction: fn => ctx.storage.transactionSync(fn) };
    this.heroes = heroStore(database);
    this.diary = diaryStore(database);
    this.maps = mapStore({ ...database, memberFor: (account, id) => this.one('SELECT id FROM accounts WHERE id = ?', id) });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  one(query, ...args) { return this.sql.exec(query, ...args).toArray()[0]; }
  room() { return this.one('SELECT code, name FROM room WHERE id = 1'); }
  bySession(tokenHash) {
    return this.one(`SELECT a.id, a.username, a.role, s.token_hash, s.expires FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires > ?`, tokenHash, Date.now());
  }
  authenticate(request) {
    const session = sessionCookie(request);
    const account = session && this.bySession(session.tokenHash);
    if (!account || session.roomCode !== this.room()?.code) throw fail(401, 'Your session has ended. Please sign in again.');
    return account;
  }

  async scheduleExpiry() {
    const next = this.one('SELECT MIN(expires) AS expires FROM sessions WHERE expires > ?', Date.now())?.expires;
    if (next) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }

  async issueSession(accountId, request) {
    const token = randomBytes(32).toString('hex');
    const tokenHash = hash(token);
    this.sql.exec('INSERT INTO sessions VALUES (?, ?, ?)', tokenHash, accountId, Date.now() + this.ttl);
    await this.scheduleExpiry();
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return `tavern_session=${this.room().code}.${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.ttl / 1000)}${secure}`;
  }

  socketAccount(socket) {
    const session = socket.deserializeAttachment();
    return session && typeof session.tokenHash === 'string' ? this.bySession(session.tokenHash) : null;
  }

  send(socket, type, data) {
    try { socket.send(JSON.stringify({ type, data })); } catch { /* disconnected socket */ }
  }

  broadcast(type, data, predicate = () => true) {
    for (const socket of this.ctx.getWebSockets()) {
      const account = this.socketAccount(socket);
      if (!account) { this.send(socket, 'expired', {}); socket.close(1008, 'Session ended'); continue; }
      if (predicate(account)) this.send(socket, type, data);
    }
  }

  presence() {
    const online = [...new Set(this.ctx.getWebSockets().map(socket => this.socketAccount(socket)?.id).filter(Boolean))];
    this.broadcast('presence', { online });
  }

  history(account) {
    return this.sql.exec(`SELECT r.*, a.username AS author FROM rolls r JOIN accounts a ON a.id = r.author_id
      WHERE r.visibility = 'public' OR r.author_id = ? OR (r.visibility = 'gm' AND ? = 'gm')
      ORDER BY r.sequence DESC LIMIT 100`, account.id, account.role).toArray().reverse().map(row => ({
      id: row.id, authorId: row.author_id, author: row.author, visibility: row.visibility,
      label: row.label, expression: row.expression, results: JSON.parse(row.results), modifier: row.modifier,
      total: row.total, createdAt: row.created_at,
    }));
  }

  members() {
    const online = new Set(this.ctx.getWebSockets().map(socket => this.socketAccount(socket)?.id).filter(Boolean));
    return this.sql.exec('SELECT id, username AS name, role FROM accounts ORDER BY role, username').toArray().map(member => ({ ...member, online: online.has(member.id) }));
  }
  state(account) {
    return { transport: 'websocket', me: { id: account.id, name: account.username, role: account.role }, room: this.room(), members: this.members(), rolls: this.history(account) };
  }

  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && authPaths.has(path)) {
        const body = await readBody(request);
        const { username, usernameKey, password } = credentials(body);
        let accountId;
        if (path === '/api/rooms') {
          if (this.room()) throw fail(409, 'That room already exists.');
          const name = typeof body.roomName === 'string' ? body.roomName.trim() : '';
          if (name.length < 2 || name.length > 64) throw fail(400, 'Give your campaign a name with 2–64 characters.');
          const encoded = await encodePassword(password);
          accountId = randomUUID();
          this.ctx.storage.transactionSync(() => {
            this.sql.exec('INSERT INTO room VALUES (1, ?, ?)', request.headers.get('X-Tavern-Room'), name);
            this.sql.exec('INSERT INTO accounts VALUES (?, ?, ?, ?, ?)', accountId, username, usernameKey, encoded, 'gm');
          });
        } else if (path === '/api/login') {
          const account = this.one('SELECT id, password_hash FROM accounts WHERE username_key = ?', usernameKey);
          const matches = await checkPassword(password, account?.password_hash);
          if (!account || !matches || !this.room()) throw fail(401, 'The room code, name or password does not match.');
          accountId = account.id;
        } else {
          if (!this.room()) throw fail(404, 'That invitation code was not found.');
          const encoded = await encodePassword(password);
          accountId = randomUUID();
          this.ctx.storage.transactionSync(() => {
            if (this.one('SELECT COUNT(*) AS count FROM accounts').count >= 6) throw fail(409, 'This table already has six accounts.');
            if (this.one('SELECT id FROM accounts WHERE username_key = ?', usernameKey)) throw fail(409, 'That name is already taken in this room. Sign in or choose another name.');
            this.sql.exec('INSERT INTO accounts VALUES (?, ?, ?, ?, ?)', accountId, username, usernameKey, encoded, 'player');
          });
        }
        const cookie = await this.issueSession(accountId, request);
        this.broadcast('members', { members: this.members() });
        return json(path === '/api/login' ? 200 : 201, { ok: true }, { 'Set-Cookie': cookie });
      }

      const account = this.authenticate(request);
      account.room_id = this.room().code;
      if (path === '/api/diary' && request.method === 'GET') return json(200, this.diary.list(account, new URL(request.url)));
      if (path.startsWith('/api/diary/') && request.method === 'GET') return json(200, { entry: this.diary.get(account, path.slice('/api/diary/'.length)) });
      if ((path === '/api/diary' || path.startsWith('/api/diary/')) && request.method === 'POST') {
        this.diary.limit(account);
        const body = await readBody(request, DIARY_BODY_LIMIT);
        const entry = path === '/api/diary' ? this.diary.create(account, body) : this.diary.update(account, path.slice('/api/diary/'.length), body);
        this.broadcast('diary', { id: entry.id, revision: entry.revision });
        return json(path === '/api/diary' ? 201 : 200, { entry });
      }
      if (path === '/api/map' && request.method === 'GET') return json(200, this.maps.state(account));
      if (path === '/api/map/image' && request.method === 'GET') {
        const image = this.maps.image(account, new URL(request.url));
        return new Response(image, { headers: { ...headers, 'Content-Type': 'image/png' } });
      }
      if (path === '/api/map/upload' && request.method === 'POST') {
        this.maps.requireGM(account); this.maps.limit(account, 'upload');
        const image = await readMap(request.body, request.headers.get('Content-Type'), request.headers.get('Content-Length'));
        this.authenticate(request);
        const result = this.maps.upload(account, new URL(request.url), image); this.broadcast('map', {}); return json(201, result);
      }
      if (path === '/api/map/action' && request.method === 'POST') {
        const body = await readBody(request); this.maps.limit(account, body.action === 'token' ? 'token' : 'fog');
        const result = this.maps.update(account, body); this.broadcast('map', { image: body.action !== 'token' }); return json(200, result);
      }
      if (path === '/api/heroes' && request.method === 'GET') return json(200, { sheets: this.heroes.list(account) });
      if (path === '/api/hero' && request.method === 'POST') {
        this.heroes.begin(account);
        const file = await readHero(request.body, request.headers.get('Content-Type'), request.headers.get('Content-Length'));
        this.authenticate(request);
        return json(201, { sheet: this.heroes.save(account, new URL(request.url), file) });
      }
      if (path.startsWith('/api/heroes/') && request.method === 'GET') {
        const sheet = this.heroes.get(account, path.slice('/api/heroes/'.length));
        return new Response(sheet.bytes, { headers: { ...headers, ...heroHeaders(sheet) } });
      }
      if (path === '/api/state' && request.method === 'GET') return json(200, this.state(account));
      if (path === '/api/rolls' && request.method === 'GET') return json(200, { rolls: this.history(account) });
      if (path === '/api/logout' && request.method === 'POST') {
        await readBody(request);
        this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', account.token_hash);
        for (const socket of this.ctx.getWebSockets(account.token_hash)) socket.close(1000, 'Signed out');
        this.presence();
        await this.scheduleExpiry();
        return json(200, { ok: true }, { 'Set-Cookie': 'tavern_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (path === '/api/rolls' && request.method === 'POST') {
        const body = await readBody(request);
        if (!audiences.has(body.visibility)) throw fail(400, 'Choose Public, Only me, or To GM.');
        if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 80)) throw fail(400, 'Keep your roll label under 80 characters.');
        let dice;
        try { dice = rollDice(body.expression); } catch (error) { throw fail(400, error.message); }
        const now = Date.now();
        const limit = this.one('SELECT count, until FROM roll_limits WHERE account_id = ?', account.id);
        if (limit && limit.until > now && limit.count >= 60) throw fail(429, 'A little too fast. Please wait a moment and try again.');
        if (!limit || limit.until <= now) this.sql.exec('INSERT OR REPLACE INTO roll_limits VALUES (?, 1, ?)', account.id, now + 60_000);
        else this.sql.exec('UPDATE roll_limits SET count = count + 1 WHERE account_id = ?', account.id);
        const roll = { id: randomUUID(), authorId: account.id, author: account.username, visibility: body.visibility, label: (body.label ?? '').trim(), ...dice, createdAt: new Date(now).toISOString() };
        this.sql.exec('INSERT INTO rolls (id, author_id, visibility, label, expression, results, modifier, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          roll.id, account.id, roll.visibility, roll.label, roll.expression, JSON.stringify(roll.results), roll.modifier, roll.total, roll.createdAt);
        this.broadcast('roll', roll, viewer => roll.visibility === 'public' || viewer.id === account.id || (roll.visibility === 'gm' && viewer.role === 'gm'));
        return json(201, { roll });
      }
      if (path === '/api/events' && request.method === 'GET') {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw fail(426, 'Connect using WebSocket.');
        const count = this.ctx.getWebSockets().filter(socket => this.socketAccount(socket)?.id === account.id).length;
        if (count >= 5) throw fail(429, 'Please close another tab before opening this room again.');
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], [account.token_hash]);
        pair[1].serializeAttachment({ tokenHash: account.token_hash });
        this.send(pair[1], 'snapshot', this.state(account));
        this.presence();
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      throw fail(404, 'Not found.');
    } catch (error) { return errorResponse(error); }
  }

  webSocketMessage(socket) {
    if (!this.socketAccount(socket)) { this.send(socket, 'expired', {}); socket.close(1008, 'Session ended'); return; }
    this.send(socket, 'error', { message: 'Use the dice form to make a roll.' });
  }
  webSocketClose(socket, code) {
    socket.close([1005, 1006, 1015].includes(code) ? 1000 : code);
    this.presence();
  }
  webSocketError(socket) { socket.close(1011, 'Connection ended'); this.presence(); }
  async alarm() {
    this.broadcast('heartbeat', {}); // Revalidates attachments and closes expired sessions.
    this.sql.exec('DELETE FROM sessions WHERE expires <= ?', Date.now());
    this.presence();
    await this.scheduleExpiry();
  }
}
