import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { decode, encode, convertIndexedToRgb, hasPngSignature } from 'fast-png';
import jpeg from 'jpeg-js';

const fail = (status, message) => Object.assign(new Error(message), { status });
export const GRID = 32;
export const MAP_PIXELS = 2_097_152;
const UPLOAD_BYTES = 8 * 1024 * 1024;
const dimensions = (width, height) => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > MAP_PIXELS) throw fail(400, 'Use a map up to 2 megapixels and 4096 pixels per side.');
};
export const MAP_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS maps (room_id TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, title TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, fog TEXT NOT NULL, published INTEGER NOT NULL, revision INTEGER NOT NULL, image_revision INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS map_chunks (map_id TEXT NOT NULL, audience TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(map_id, audience, part))',
  'CREATE TABLE IF NOT EXISTS map_tokens (room_id TEXT NOT NULL, owner_id TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, PRIMARY KEY(room_id, owner_id))',
  'CREATE TABLE IF NOT EXISTS map_limits (account_id TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL, until INTEGER NOT NULL, PRIMARY KEY(account_id, bucket))',
];

// Drop metadata/animation chunks and check decompression bounds before the PNG decoder.
function safePng(bytes) {
  if (!hasPngSignature(bytes) || bytes.length < 33) throw new Error('Invalid PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  dimensions(view.getUint32(16), view.getUint32(20));
  const kept = [bytes.slice(0, 8)], compressed = [];
  let end = false, header = false, size = 8, compressedSize = 0, chunkCount = 0;
  for (let pos = 8; pos + 12 <= bytes.length;) {
    if (++chunkCount > 10000) throw new Error('Too many PNG chunks');
    const length = view.getUint32(pos), next = pos + length + 12;
    if (next > bytes.length) throw new Error('Truncated PNG');
    const type = String.fromCharCode(...bytes.slice(pos + 4, pos + 8));
    if (type === 'IHDR') { if (header || pos !== 8 || length !== 13) throw new Error('Invalid PNG header'); header = true; }
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) { kept.push(bytes.slice(pos, next)); size += next - pos; }
    if (type === 'IDAT') { compressed.push(bytes.slice(pos + 8, pos + 8 + length)); compressedSize += length; }
    if (type === 'IEND') { end = true; break; }
    pos = next;
  }
  if (!end || !header || !compressedSize) throw new Error('Incomplete PNG');
  const deflated = new Uint8Array(compressedSize); let offset = 0;
  for (const part of compressed) { deflated.set(part, offset); offset += part.length; }
  inflateSync(deflated, { maxOutputLength: view.getUint32(16) * view.getUint32(20) * 8 + view.getUint32(20) * 8 + 1024 });
  const clean = new Uint8Array(size); offset = 0;
  for (const part of kept) { clean.set(part, offset); offset += part.length; }
  return clean;
}

export function mapImage(bytes, mime) {
  try {
    let image;
    if (mime === 'image/png') {
      image = decode(safePng(bytes), { checkCrc: true });
      if (image.palette) image = { ...image, data: convertIndexedToRgb(image), channels: image.palette[0].length, depth: 8 };
      if (image.depth < 8) throw new Error('Low-depth grayscale');
    } else if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
      image = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: MAP_PIXELS / 1_000_000, maxMemoryUsageInMB: 48, formatAsRGBA: true, tolerantDecoding: false });
      image = { ...image, channels: 4, depth: 8 };
    } else throw new Error('Unsupported image');
    dimensions(image.width, image.height);
    // Canonical opaque RGBA pixels: no EXIF, hidden layers, ancillary data or transparency.
    const pixels = new Uint8Array(image.width * image.height * 4), divisor = image.depth === 16 ? 257 : 1;
    for (let i = 0; i < image.width * image.height; i++) {
      const offset = i * image.channels, gray = image.channels < 3;
      const alpha = image.channels === 2 || image.channels === 4 ? image.data[offset + image.channels - 1] / divisor / 255 : 1;
      for (let c = 0; c < 3; c++) pixels[i * 4 + c] = Math.round(image.data[offset + (gray ? 0 : c)] / divisor * alpha + 245 * (1 - alpha));
      pixels[i * 4 + 3] = 255;
    }
    return { width: image.width, height: image.height, data: pixels, channels: 4, depth: 8 };
  } catch (err) { if (err.status) throw err; throw fail(400, 'That image could not be opened. Choose a PNG or JPEG up to 2 megapixels.'); }
}

export async function readMap(body, mime, length) {
  mime = mime?.split(';')[0];
  if (!['image/png', 'image/jpeg'].includes(mime)) throw fail(415, 'Choose a PNG or JPEG map.');
  if (Number(length) > UPLOAD_BYTES) throw fail(413, 'Maps can be up to 8 MiB.');
  if (!body) throw fail(400, 'Choose a map image.');
  const chunks = []; let size = 0;
  for await (const chunk of body) { size += chunk.byteLength; if (size > UPLOAD_BYTES) throw fail(413, 'Maps can be up to 8 MiB.'); chunks.push(chunk); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return mapImage(bytes, mime);
}

export function maskedImage(image, fog) {
  const data = new Uint8Array(image.data.length);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4, visible = fog[Math.floor(y / image.height * GRID) * GRID + Math.floor(x / image.width * GRID)] === '1';
    data.set(visible ? image.data.subarray(i, i + 4) : [14, 25, 28, 255], i);
  }
  return encode({ ...image, data }, { zlib: { level: 1 } });
}

export function mapStore({ query, run, transaction, memberFor }) {
  const one = (sql, ...args) => query(sql, ...args)[0];
  const row = account => one('SELECT * FROM maps WHERE room_id = ?', account.room_id);
  const gm = account => { if (account.role !== 'gm') throw fail(403, 'Only the game master can change the map or fog.'); };
  const openCell = (map, x, y) => map.fog[Math.min(31, Math.floor(y * GRID)) * GRID + Math.min(31, Math.floor(x * GRID))] === '1';
  const load = (map, audience) => {
    const parts = query('SELECT data FROM map_chunks WHERE map_id = ? AND audience = ? ORDER BY part', map.id, audience).map(part => new Uint8Array(part.data));
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
  };
  const save = (id, audience, bytes) => {
    run('DELETE FROM map_chunks WHERE map_id = ? AND audience = ?', id, audience);
    for (let offset = 0, part = 0; offset < bytes.length; offset += 65536, part++) run('INSERT INTO map_chunks VALUES (?, ?, ?, ?)', id, audience, part, bytes.slice(offset, offset + 65536));
  };
  const state = account => {
    const map = row(account);
    if (!map || (!map.published && account.role !== 'gm')) return { map: null };
    const tokens = query('SELECT t.owner_id, t.x, t.y, a.username FROM map_tokens t JOIN accounts a ON a.id = t.owner_id WHERE t.room_id = ?', account.room_id)
      .filter(token => account.role === 'gm' || openCell(map, token.x, token.y))
      .map(token => ({ ownerId: token.owner_id, name: token.username, x: token.x, y: token.y, concealed: !openCell(map, token.x, token.y) }));
    return { map: { id: map.id, title: map.title, width: map.width, height: map.height, revision: map.revision, imageRevision: map.image_revision, published: !!map.published, grid: GRID, ...(account.role === 'gm' ? { fog: map.fog } : {}), tokens } };
  };
  function checkVersion(map, body) {
    if (!map || body.mapId !== map.id || body.revision !== map.revision) throw fail(409, 'The map changed. Refresh it and try again.');
  }
  return {
    state,
    limit(account, bucket) {
      const maximum = bucket === 'upload' ? 3 : bucket === 'fog' ? 30 : 120, now = Date.now();
      const old = one('SELECT count, until FROM map_limits WHERE account_id = ? AND bucket = ?', account.id, bucket);
      if (!old || old.until <= now) run('INSERT OR REPLACE INTO map_limits VALUES (?, ?, 1, ?)', account.id, bucket, now + 60_000);
      else { if (old.count >= maximum) throw fail(429, 'A little too fast. Please wait a moment before changing the map again.'); run('UPDATE map_limits SET count = count + 1 WHERE account_id = ? AND bucket = ?', account.id, bucket); }
    },
    requireGM: gm,
    upload(account, url, image) {
      gm(account);
      const title = (url.searchParams.get('title') || '').trim();
      if (!title || title.length > 80 || /[\x00-\x1f]/.test(title)) throw fail(400, 'Give the map a title with 1–80 characters.');
      const old = row(account);
      if (old && url.searchParams.get('replace') !== old.id) throw fail(409, 'Confirm replacement of the current map.');
      const id = randomUUID(), fog = '0'.repeat(GRID * GRID), original = encode(image, { zlib: { level: 1 } }), hidden = maskedImage(image, fog);
      transaction(() => {
        if (old) run('DELETE FROM map_chunks WHERE map_id = ?', old.id);
        run('DELETE FROM map_tokens WHERE room_id = ?', account.room_id);
        run('INSERT OR REPLACE INTO maps VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1)', account.room_id, id, title, image.width, image.height, fog);
        save(id, 'gm', original); save(id, 'player', hidden);
      });
      return state(account);
    },
    update(account, body) {
      const map = row(account); checkVersion(map, body);
      if (body.action === 'token') {
        const ownerId = body.ownerId;
        if (typeof ownerId !== 'string' || (ownerId !== account.id && account.role !== 'gm')) throw fail(403, 'You can move only your own token.');
        const member = memberFor(account, ownerId);
        if (!member || (account.role !== 'gm' && ownerId !== account.id)) throw fail(400, 'Choose a member of this table.');
        if (!Number.isFinite(body.x) || !Number.isFinite(body.y) || body.x < 0 || body.x >= 1 || body.y < 0 || body.y >= 1) throw fail(400, 'Place the token inside the map.');
        if (account.role !== 'gm' && (!map.published || !openCell(map, body.x, body.y))) throw fail(403, 'Place your token in a revealed area.');
        transaction(() => {
          run('INSERT OR REPLACE INTO map_tokens VALUES (?, ?, ?, ?)', account.room_id, ownerId, body.x, body.y);
          run('UPDATE maps SET revision = revision + 1 WHERE room_id = ?', account.room_id);
        });
      } else {
        gm(account);
        if (body.action === 'publish') {
          if (typeof body.published !== 'boolean') throw fail(400, 'Choose whether to share the map.');
          run('UPDATE maps SET published = ?, revision = revision + 1 WHERE room_id = ?', body.published ? 1 : 0, account.room_id);
        } else if (['fog', 'reveal-all', 'hide-all'].includes(body.action)) {
          let fog;
          if (body.action === 'fog') {
            if (!['reveal', 'hide'].includes(body.mode) || ![body.x, body.y, body.width, body.height].every(Number.isInteger) || body.x < 0 || body.y < 0 || body.width < 1 || body.height < 1 || body.x + body.width > GRID || body.y + body.height > GRID) throw fail(400, 'Select a valid fog rectangle.');
            fog = map.fog.split('');
            for (let y = body.y; y < body.y + body.height; y++) for (let x = body.x; x < body.x + body.width; x++) fog[y * GRID + x] = body.mode === 'reveal' ? '1' : '0';
            fog = fog.join('');
          } else fog = (body.action === 'reveal-all' ? '1' : '0').repeat(GRID * GRID);
          const image = decode(load(map, 'gm')), redacted = maskedImage(image, fog);
          transaction(() => { save(map.id, 'player', redacted); run('UPDATE maps SET fog = ?, revision = revision + 1, image_revision = image_revision + 1 WHERE room_id = ?', fog, account.room_id); });
        } else throw fail(400, 'Choose a map action.');
      }
      return state(account);
    },
    image(account, url) {
      const map = row(account);
      if (!map || url.searchParams.get('id') !== map.id || (!map.published && account.role !== 'gm')) throw fail(404, 'That map is not available.');
      if (url.searchParams.get('version') !== String(map.image_revision)) throw fail(409, 'The map image changed.');
      return load(map, account.role === 'gm' ? 'gm' : 'player');
    },
  };
}
