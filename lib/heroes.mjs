import { randomUUID } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
export const HERO_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS hero_sheets (id TEXT UNIQUE NOT NULL, owner_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, file_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('public','private','gm')), updated_at TEXT NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS hero_chunks (sheet_id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(sheet_id, part))',
  'CREATE TABLE IF NOT EXISTS hero_limits (owner_id TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL)',
];
export const HERO_LIMITS = { 'application/pdf': 10 * 1024 * 1024, 'application/json': 2 * 1024 * 1024 };

export async function readHero(body, contentType, length) {
  const mime = contentType?.split(';')[0];
  const limit = HERO_LIMITS[mime];
  if (!limit) throw fail(415, 'Choose a PDF or a Heldenbau JSON export.');
  if (length && Number(length) > limit) throw fail(413, 'PDFs can be up to 10 MiB; hero files up to 2 MiB.');
  if (!body) throw fail(400, 'Choose a file first.');
  const chunks = [];
  let size = 0;
  // Web streams and Node request streams both support async iteration.
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > limit) throw fail(413, 'PDFs can be up to 10 MiB; hero files up to 2 MiB.');
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (mime === 'application/pdf') {
    const decoder = new TextDecoder();
    if (!decoder.decode(bytes.slice(0, 8)).startsWith('%PDF-') || !decoder.decode(bytes.slice(-2048)).includes('%%EOF')) throw fail(400, 'That file does not look like a complete PDF.');
  } else {
    try {
      const hero = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!hero || typeof hero !== 'object' || Array.isArray(hero) || typeof hero.name !== 'string' || !hero.attributes || typeof hero.attributes !== 'object' || Array.isArray(hero.attributes)) throw new Error();
      for (const key of ['MU', 'KL', 'IN', 'CH', 'FF', 'GE', 'KO', 'KK']) if (!Number.isFinite(hero.attributes[key])) throw new Error();
    } catch { throw fail(400, 'Use the JSON file downloaded with “Als Datei” in Heldenbau.'); }
  }
  return { bytes, mime };
}

export function heroStore({ query, run, transaction }) {
  const one = (sql, ...args) => query(sql, ...args)[0];
  const visible = (row, account) => row.room_id === account.room_id && (row.owner_id === account.id || row.visibility === 'public' || (row.visibility === 'gm' && account.role === 'gm'));
  const metadata = row => ({ id: row.id, ownerId: row.owner_id, owner: row.owner, fileName: row.file_name, mime: row.mime, size: row.size, visibility: row.visibility, updatedAt: row.updated_at });
  return {
    list(account) {
      return query(`SELECT h.*, a.username AS owner FROM hero_sheets h JOIN accounts a ON a.id = h.owner_id WHERE h.room_id = ? AND (h.owner_id = ? OR h.visibility = 'public' OR (h.visibility = 'gm' AND ? = 'gm')) ORDER BY a.username`, account.room_id, account.id, account.role).map(metadata);
    },
    begin(account) {
      const now = Date.now();
      const row = one('SELECT count, until FROM hero_limits WHERE owner_id = ?', account.id);
      if (!row || row.until <= now) run('INSERT OR REPLACE INTO hero_limits VALUES (?, 1, ?)', account.id, now + 60_000);
      else {
        if (row.count >= 5) throw fail(429, 'Please wait a minute before uploading another sheet.');
        run('UPDATE hero_limits SET count = count + 1 WHERE owner_id = ?', account.id);
      }
    },
    save(account, url, { bytes, mime }) {
      const visibility = url.searchParams.get('visibility');
      if (!['public', 'private', 'gm'].includes(visibility)) throw fail(400, 'Choose who can see the sheet.');
      const fileName = (url.searchParams.get('name') || '').trim();
      if (!fileName || fileName.length > 120 || /[\x00-\x1f\x7f/\\]/.test(fileName) || !fileName.toLowerCase().endsWith(mime === 'application/pdf' ? '.pdf' : '.json')) throw fail(400, 'Use a PDF or JSON filename under 120 characters.');
      const row = { id: randomUUID(), owner_id: account.id, room_id: account.room_id, owner: account.username, file_name: fileName, mime, size: bytes.length, visibility, updated_at: new Date().toISOString() };
      transaction(() => {
        const old = one('SELECT id FROM hero_sheets WHERE owner_id = ?', account.id);
        if (old) run('DELETE FROM hero_chunks WHERE sheet_id = ?', old.id);
        run('INSERT OR REPLACE INTO hero_sheets VALUES (?, ?, ?, ?, ?, ?, ?, ?)', row.id, account.id, account.room_id, fileName, mime, bytes.length, visibility, row.updated_at);
        for (let part = 0, offset = 0; offset < bytes.length; part++, offset += 65536) run('INSERT INTO hero_chunks VALUES (?, ?, ?)', row.id, part, bytes.slice(offset, offset + 65536));
      });
      return metadata(row);
    },
    get(account, id) {
      const row = one('SELECT * FROM hero_sheets WHERE id = ?', id);
      if (!row || !visible(row, account)) throw fail(404, 'That sheet is not available.');
      const bytes = new Uint8Array(row.size);
      let offset = 0;
      for (const chunk of query('SELECT data FROM hero_chunks WHERE sheet_id = ? ORDER BY part', id)) { const data = new Uint8Array(chunk.data); bytes.set(data, offset); offset += data.length; }
      if (offset !== row.size) throw new Error('Incomplete hero sheet storage.');
      return { bytes, mime: row.mime, fileName: row.file_name };
    },
  };
}

export function heroHeaders(sheet) {
  return { 'Content-Type': sheet.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename="hero.${sheet.mime === 'application/pdf' ? 'pdf' : 'json'}"; filename*=UTF-8''${encodeURIComponent(sheet.fileName).replace(/'/g, '%27')}`, 'Content-Security-Policy': "sandbox; default-src 'none'" };
}
