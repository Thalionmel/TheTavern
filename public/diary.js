export function setupDiary({ getAccount, api, toast }) {
  const $ = id => document.getElementById(id);
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const day = date => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
  let active = false, selected = null, editing = false, dirty = false, busy = false, requestId;
  let page = 1, listEpoch = 0, entryEpoch = 0, timer, pendingSwitch, drag;
  const me = () => getAccount()?.id;
  const report = text => { $('diary-error').textContent = text || ''; $('diary-error').hidden = !text; };
  function buttons() {
    $('diary-save').disabled = busy;
    $('diary-new').disabled = busy;
    $('diary-edit').disabled = busy;
    $('diary-archive').disabled = busy;
    $('diary-draft-state').textContent = busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'Shared with everyone at this table';
    $('diary-count').textContent = `${$('diary-body').value.length} / 6000`;
  }
  function show(entry) {
    selected = entry; editing = false; dirty = false; pendingSwitch = null;
    $('diary-discard').hidden = true; $('diary-conflict').hidden = true;
    $('diary-editor').hidden = true; $('diary-detail').hidden = false; $('diary-welcome').hidden = true;
    $('diary-entry-title').textContent = entry.title;
    $('diary-entry-meta').textContent = `${day(entry.eventDate)} · ${entry.author}${entry.archived ? ' · Archived' : ''}`;
    $('diary-entry-aventurian').textContent = entry.aventurianDate;
    $('diary-entry-aventurian').hidden = !entry.aventurianDate;
    $('diary-entry-body').textContent = entry.body;
    $('diary-entry-edited').textContent = entry.revision > 1 ? `Last changed by ${entry.editor} · ${new Date(entry.updatedAt).toLocaleString()}` : `Added ${new Date(entry.createdAt).toLocaleString()}`;
    $('diary-edit').hidden = !entry.canEdit || entry.archived;
    $('diary-archive').hidden = !entry.canEdit;
    $('diary-archive').textContent = entry.archived ? 'Restore entry' : 'Archive entry';
    for (const button of $('diary-list').querySelectorAll('[data-entry]')) button.setAttribute('aria-current', String(button.dataset.entry === entry.id));
    buttons();
  }
  function edit(entry = null) {
    selected = entry; editing = true; dirty = false; requestId = crypto.randomUUID();
    $('diary-detail').hidden = true; $('diary-welcome').hidden = true; $('diary-editor').hidden = false;
    $('diary-editor-title').textContent = entry ? 'Edit the story' : 'A moment worth remembering';
    $('diary-title').value = entry?.title || ''; $('diary-date').value = entry?.eventDate || today();
    $('diary-aventurian').value = entry?.aventurianDate || ''; $('diary-body').value = entry?.body || '';
    $('diary-conflict').hidden = true; report(); buttons(); $('diary-title').focus({ preventScroll: true });
  }
  function switchTo(action) {
    if (busy) return;
    if (editing && dirty) { pendingSwitch = action; $('diary-discard').hidden = false; $('diary-keep').focus({ preventScroll: true }); return; }
    action();
  }
  async function load(id) {
    const epoch = ++entryEpoch, owner = me(); report();
    try {
      const { entry } = await api(`/api/diary/${encodeURIComponent(id)}`);
      if (epoch !== entryEpoch || owner !== me()) return;
      show(entry);
    } catch (err) { if (epoch === entryEpoch && owner === me()) report(err.message); }
  }
  async function checkSelected() {
    if (!selected) return;
    const id = selected.id, owner = me(), epoch = ++entryEpoch;
    try {
      const { entry } = await api(`/api/diary/${encodeURIComponent(id)}`);
      if (epoch !== entryEpoch || owner !== me() || selected?.id !== id) return;
      if (editing) {
        if (entry.revision !== selected.revision) $('diary-conflict').hidden = false;
      } else show(entry);
    } catch (err) { if (epoch === entryEpoch && owner === me()) report(err.message); }
  }
  async function refresh({ check = false } = {}) {
    if (!active || !me()) return;
    const epoch = ++listEpoch, owner = me();
    const query = new URLSearchParams({ search: $('diary-search').value.trim(), archived: $('diary-filter').value, page });
    try {
      const result = await api(`/api/diary?${query}`);
      if (epoch !== listEpoch || owner !== me()) return;
      page = result.page;
      $('diary-list').replaceChildren(...result.entries.map(entry => {
        const li = node('li'), button = node('button', 'diary-card'); button.type = 'button'; button.dataset.entry = entry.id; button.setAttribute('aria-label', `Read ${entry.title}`);
        button.setAttribute('aria-current', String(selected?.id === entry.id));
        button.append(node('span', 'diary-card-date', `${day(entry.eventDate)} · ${entry.author}`), node('strong', '', entry.title));
        if (entry.aventurianDate) button.append(node('span', 'diary-card-world', entry.aventurianDate));
        button.append(node('span', 'diary-card-excerpt', entry.excerpt));
        button.addEventListener('click', () => switchTo(() => load(entry.id))); li.append(button); return li;
      }));
      $('diary-empty-list').hidden = result.entries.length > 0;
      $('diary-empty-list').textContent = $('diary-search').value.trim() ? 'No matching entries.' : $('diary-filter').value === '1' ? 'No archived entries.' : 'The first page is yours to write.';
      $('diary-page').textContent = `${result.total} ${result.total === 1 ? 'entry' : 'entries'} · Page ${page} of ${result.pages}`;
      $('diary-previous').disabled = page <= 1; $('diary-next').disabled = page >= result.pages;
      if (!selected && !editing && result.entries.length) await load(result.entries[0].id);
      else if (check) await checkSelected();
    } catch (err) { if (epoch === listEpoch && owner === me()) report(err.message); }
  }
  $('diary-new').addEventListener('click', () => switchTo(() => { entryEpoch++; edit(); }));
  $('diary-edit').addEventListener('click', () => { if (selected?.canEdit && !selected.archived) { entryEpoch++; edit(selected); } });
  $('diary-cancel').addEventListener('click', () => switchTo(() => { entryEpoch++; if (selected) show(selected); else { editing = false; dirty = false; $('diary-editor').hidden = true; $('diary-welcome').hidden = false; } }));
  $('diary-keep').addEventListener('click', () => { pendingSwitch = null; $('diary-discard').hidden = true; $('diary-body').focus({ preventScroll: true }); });
  $('diary-discard-confirm').addEventListener('click', () => { const action = pendingSwitch; pendingSwitch = null; dirty = false; $('diary-discard').hidden = true; action?.(); });
  $('diary-reload-entry').addEventListener('click', () => { if (selected) switchTo(() => load(selected.id)); });
  $('diary-form').addEventListener('input', () => { dirty = true; buttons(); });
  $('diary-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !me()) return;
    busy = true; buttons(); report(); const owner = me();
    const body = { title: $('diary-title').value, body: $('diary-body').value, eventDate: $('diary-date').value, aventurianDate: $('diary-aventurian').value, ...(selected ? { action: 'edit', revision: selected.revision } : { requestId }) };
    const path = selected ? `/api/diary/${encodeURIComponent(selected.id)}` : '/api/diary';
    try {
      const result = await api(path, body);
      if (owner !== me()) return;
      entryEpoch++; show(result.entry); toast('The diary entry is saved for your party.'); await refresh();
    } catch (err) { if (owner === me()) { report(err.message); if (selected && err.status === 409) $('diary-conflict').hidden = false; } }
    finally { if (owner === me()) { busy = false; buttons(); } }
  });
  $('diary-archive').addEventListener('click', async () => {
    if (busy || !selected?.canEdit || !me()) return;
    busy = true; buttons(); report(); const owner = me(), id = selected.id;
    try {
      const { entry } = await api(`/api/diary/${encodeURIComponent(id)}`, { action: selected.archived ? 'restore' : 'archive', revision: selected.revision });
      if (owner !== me()) return;
      entryEpoch++; show(entry); toast(entry.archived ? 'Entry archived. You can restore it at any time.' : 'Entry restored.'); await refresh();
    } catch (err) { if (owner === me()) { report(err.message); await checkSelected(); } }
    finally { if (owner === me()) { busy = false; buttons(); } }
  });
  $('diary-search').addEventListener('input', () => { page = 1; clearTimeout(timer); timer = setTimeout(() => refresh(), 250); });
  $('diary-filter').addEventListener('change', () => { page = 1; refresh(); });
  $('diary-previous').addEventListener('click', () => { page = Math.max(1, page - 1); refresh(); });
  $('diary-next').addEventListener('click', () => { page++; refresh(); });
  $('diary-refresh').addEventListener('click', () => refresh({ check: true }));
  function open() {
    if (!me()) return;
    active = true; $('diary-window').hidden = false; $('restore-diary').hidden = false;
    for (const id of ['dice-window', 'hero-window', 'map-window']) $(id).style.zIndex = '30'; $('diary-window').style.zIndex = '34';
    refresh({ check: true }); $('diary-new').focus({ preventScroll: true });
  }
  function close() { active = false; clearTimeout(timer); listEpoch++; entryEpoch++; $('diary-window').hidden = true; $('restore-diary').hidden = true; if (me()) $('open-diary').focus({ preventScroll: true }); }
  $('open-diary').addEventListener('click', open); $('restore-diary').addEventListener('click', open); $('close-diary').addEventListener('click', close);
  $('maximize-diary').addEventListener('click', () => { const on = $('diary-window').classList.toggle('maximized'); $('maximize-diary').setAttribute('aria-label', on ? 'Restore diary window size' : 'Maximize diary window'); });
  $('diary-drag').addEventListener('pointerdown', event => {
    if (event.target.closest('button') || event.button !== 0 || $('diary-window').classList.contains('maximized')) return;
    const rect = $('diary-window').getBoundingClientRect(); drag = { id: event.pointerId, x: event.clientX - rect.x, y: event.clientY - rect.y }; $('diary-drag').setPointerCapture(event.pointerId);
  });
  $('diary-drag').addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    $('diary-window').style.left = `${Math.max(8, Math.min(event.clientX - drag.x, innerWidth - $('diary-window').offsetWidth - 8))}px`;
    $('diary-window').style.top = `${Math.max(8, Math.min(event.clientY - drag.y, innerHeight - 100))}px`;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('diary-drag').addEventListener(type, () => { drag = null; });
  window.addEventListener('resize', () => { if (innerWidth <= 680) { $('diary-window').style.left = ''; $('diary-window').style.top = ''; } });
  return {
    changed(packet = {}) {
      if (!active) return;
      if (selected?.id === packet.id && editing && !busy && packet.revision > selected.revision) $('diary-conflict').hidden = false;
      clearTimeout(timer); timer = setTimeout(() => refresh({ check: !busy && (!packet.id || packet.id === selected?.id) }), 80);
    },
    reset() {
      close(); selected = null; editing = dirty = busy = false; page = 1; requestId = null; pendingSwitch = null;
      $('diary-form').reset(); $('diary-search').value = ''; $('diary-filter').value = '0';
      $('diary-list').replaceChildren(); $('diary-page').textContent = ''; $('diary-empty-list').textContent = '';
      for (const id of ['diary-entry-title', 'diary-entry-meta', 'diary-entry-aventurian', 'diary-entry-body', 'diary-entry-edited']) $(id).textContent = '';
      $('diary-editor').hidden = $('diary-detail').hidden = true; $('diary-welcome').hidden = false;
      $('diary-discard').hidden = $('diary-conflict').hidden = true; report(); buttons();
    },
  };
}
