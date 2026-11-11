import { randomUUID } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
export const DIARY_BODY_LIMIT = 32768;
export const DIARY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS diary_entries (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, author_id TEXT NOT NULL, editor_id TEXT NOT NULL, request_key TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, event_date TEXT NOT NULL, aventurian_date TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(room_id, author_id, request_key))`,
  'CREATE INDEX IF NOT EXISTS diary_room_date ON diary_entries(room_id, archived, event_date DESC, created_at DESC, id DESC)',
  'CREATE TABLE IF NOT EXISTS diary_limits (account_id TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL)',
];
function fields(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.body === 'string' ? body.body.trim() : '';
  const aventurianDate = body.aventurianDate === undefined ? '' : typeof body.aventurianDate === 'string' ? body.aventurianDate.trim() : null;
  if (!title || title.length > 120) throw fail(400, 'Give the entry a title with 1–120 characters.');
  if (!content || content.length > 6000) throw fail(400, 'Write an entry with 1–6000 characters.');
  if (aventurianDate === null || aventurianDate.length > 80) throw fail(400, 'Keep the Aventurian date under 80 characters.');
  const eventDate = body.eventDate;
  try {
    if (typeof eventDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || eventDate < '0001-01-01' || new Date(`${eventDate}T00:00:00Z`).toISOString().slice(0, 10) !== eventDate) throw new Error();
  } catch { throw fail(400, 'Choose a valid calendar date for this entry.'); }
  return { title, body: content, eventDate, aventurianDate };
}

export function diaryStore({ query, run, transaction }) {
  const one = (sql, ...args) => query(sql, ...args)[0];
  const base = `SELECT d.*, a.username AS author, e.username AS editor FROM diary_entries d JOIN accounts a ON a.id = d.author_id JOIN accounts e ON e.id = d.editor_id`;
  const serialize = (row, account, full = true) => ({
    id: row.id, authorId: row.author_id, author: row.author, editor: row.editor, title: row.title,
    ...(full ? { body: row.body } : { excerpt: row.body.slice(0, 240) }),
    eventDate: row.event_date, aventurianDate: row.aventurian_date, archived: !!row.archived,
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    canEdit: account.id === row.author_id || account.role === 'gm',
  });
  function get(account, id) {
    const row = one(`${base} WHERE d.id = ? AND d.room_id = ?`, id, account.room_id);
    if (!row) throw fail(404, 'That diary entry is not available.');
    return serialize(row, account);
  }
  return {
    get,
    list(account, url) {
      const search = (url.searchParams.get('search') || '').trim();
      const archive = url.searchParams.get('archived') || '0';
      const requestedPage = Number(url.searchParams.get('page') || 1);
      if (search.length > 100 || !['0', '1'].includes(archive) || !Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 10000) throw fail(400, 'Choose a valid diary search or page.');
      const where = `d.room_id = ? AND d.archived = ? AND (? = '' OR INSTR(LOWER(d.title || ' ' || d.body || ' ' || d.aventurian_date), LOWER(?)) > 0)`;
      const args = [account.room_id, Number(archive), search, search];
      const total = one(`SELECT COUNT(*) AS count FROM diary_entries d WHERE ${where}`, ...args).count;
      const pages = Math.max(1, Math.ceil(total / 50)), page = Math.min(requestedPage, pages);
      const entries = query(`${base} WHERE ${where} ORDER BY d.event_date DESC, d.created_at DESC, d.id DESC LIMIT 50 OFFSET ?`, ...args, (page - 1) * 50).map(row => serialize(row, account, false));
      return { entries, total, page, pages };
    },
    limit(account) {
      const now = Date.now(), old = one('SELECT count, until FROM diary_limits WHERE account_id = ?', account.id);
      if (!old || old.until <= now) run('INSERT OR REPLACE INTO diary_limits VALUES (?, 1, ?)', account.id, now + 60_000);
      else {
        if (old.count >= 30) throw fail(429, 'Please wait a minute before changing the diary again.');
        run('UPDATE diary_limits SET count = count + 1 WHERE account_id = ?', account.id);
      }
    },
    create(account, body) {
      const data = fields(body);
      if (typeof body.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.requestId)) throw fail(400, 'Start a new diary entry before saving.');
      const requestKey = body.requestId.toLowerCase();
      const prior = one('SELECT * FROM diary_entries WHERE room_id = ? AND author_id = ? AND request_key = ?', account.room_id, account.id, requestKey);
      if (prior) {
        if (prior.archived || prior.title !== data.title || prior.body !== data.body || prior.event_date !== data.eventDate || prior.aventurian_date !== data.aventurianDate) throw fail(409, 'This draft was already saved with different content. Open its saved entry before trying again.');
        return get(account, prior.id);
      }
      const id = randomUUID(), now = new Date().toISOString();
      transaction(() => {
        if (one('SELECT COUNT(*) AS count FROM diary_entries WHERE room_id = ?', account.room_id).count >= 5000) throw fail(409, 'This campaign diary has reached its limit of 5,000 entries.');
        run('INSERT INTO diary_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)', id, account.room_id, account.id, account.id, requestKey, data.title, data.body, data.eventDate, data.aventurianDate, now, now);
      });
      return get(account, id);
    },
    update(account, id, body) {
      const entry = get(account, id);
      if (!entry.canEdit) throw fail(403, 'Only the author or game master can change this entry.');
      if (!Number.isInteger(body.revision) || body.revision !== entry.revision) throw fail(409, 'This entry changed at the table. Your draft is still here; reload the saved entry before editing again.');
      if (!['edit', 'archive', 'restore'].includes(body.action)) throw fail(400, 'Choose whether to edit, archive or restore the entry.');
      const now = new Date().toISOString();
      if (body.action === 'edit') {
        if (entry.archived) throw fail(409, 'Restore the entry before editing it. Your draft has been kept.');
        const data = fields(body);
        run('UPDATE diary_entries SET title = ?, body = ?, event_date = ?, aventurian_date = ?, editor_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND room_id = ?', data.title, data.body, data.eventDate, data.aventurianDate, account.id, now, id, account.room_id);
      } else {
        run('UPDATE diary_entries SET archived = ?, editor_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND room_id = ?', body.action === 'archive' ? 1 : 0, account.id, now, id, account.room_id);
      }
      return get(account, id);
    },
  };
}
