export function setupMaps({ getContext, api, toast }) {
  const $ = id => document.getElementById(id);
  let map, bitmap, imageKey, generation = 0, active = false, busy = false, mode = 'move', gesture, refreshTimer, windowDrag;
  const me = () => getContext()?.me;
  const gm = () => me()?.role === 'gm';
  const report = message => { $('map-error').textContent = message || ''; $('map-error').hidden = !message; };
  function clearImage() {
    bitmap?.close(); bitmap = null; imageKey = null;
    $('map-canvas').width = $('map-canvas').height = 0;
    $('map-tokens').replaceChildren(); $('map-surface').hidden = true;
    $('map-empty').hidden = false;
  }
  function controls() {
    $('map-gm').hidden = !gm();
    $('map-tools').hidden = !map;
    $('map-gm-tools').hidden = !gm();
    $('map-upload-heading').textContent = map ? 'Replace the current map' : 'Bring a map to the table';
    $('map-replacement').hidden = !map;
    $('map-replace').required = !!map;
    $('map-publish').textContent = map?.published ? 'Hide from players' : 'Show to players';
    $('map-state').textContent = !map ? (gm() ? 'No map yet' : 'Waiting for the GM') : gm() ? (map.published ? 'Shared with the party' : 'GM only · not shared') : 'Live · revealed terrain';
    $('map-heading').textContent = map?.title || 'A world waiting to unfold';
    const previous = $('map-token-owner').value;
    $('map-token-owner').replaceChildren();
    for (const member of getContext()?.members || []) {
      if (!gm() && member.id !== me()?.id) continue;
      const option = document.createElement('option'); option.value = member.id; option.textContent = `${member.name}${member.id === me()?.id ? ' (you)' : ''}`; $('map-token-owner').append(option);
    }
    $('map-token-owner').value = [...$('map-token-owner').options].some(option => option.value === previous) ? previous : me()?.id || '';
    for (const button of document.querySelectorAll('[data-map-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mapMode === mode));
    $('map-help').textContent = mode === 'reveal' || mode === 'hide' ? `Drag a rectangle to ${mode} terrain. Fog follows a 32 × 32 editing grid.` : mode === 'place' ? 'Click a revealed area to place your selected token. The GM can place tokens anywhere.' : 'Drag your token to move it. Focus a token and use arrow keys for smaller moves. Scroll to explore a zoomed map.';
    $('map-surface').style.touchAction = mode === 'move' ? 'pan-x pan-y' : 'none';
    for (const button of document.querySelectorAll('[data-map-command], #map-upload-button')) button.disabled = busy;
  }
  function paint(selection) {
    if (!bitmap || !map) return;
    const canvas = $('map-canvas'), ctx = canvas.getContext('2d');
    canvas.width = map.width; canvas.height = map.height;
    ctx.drawImage(bitmap, 0, 0);
    if (gm()) {
      ctx.fillStyle = 'rgba(8,19,22,.72)';
      for (let y = 0; y < map.grid; y++) for (let x = 0; x < map.grid; x++) if (map.fog[y * map.grid + x] !== '1') {
        const x0 = Math.ceil(x * map.width / map.grid), y0 = Math.ceil(y * map.height / map.grid);
        ctx.fillRect(x0, y0, Math.ceil((x + 1) * map.width / map.grid) - x0, Math.ceil((y + 1) * map.height / map.grid) - y0);
      }
    }
    if (selection) {
      const [start, end] = selection; ctx.fillStyle = mode === 'reveal' ? '#e6c37666' : '#863d5166'; ctx.strokeStyle = '#ffe6a4'; ctx.lineWidth = Math.max(1, map.width / 600);
      const x = Math.min(start.x, end.x) * map.width, y = Math.min(start.y, end.y) * map.height, width = Math.abs(start.x - end.x) * map.width, height = Math.abs(start.y - end.y) * map.height;
      ctx.fillRect(x, y, width, height); ctx.strokeRect(x, y, width, height);
    }
  }
  function fit() {
    if (!map) return;
    const viewport = $('map-viewport'), zoom = $('map-zoom').value;
    $('map-surface').style.width = zoom === 'fit' ? `${Math.max(1, Math.min(viewport.clientWidth - 2, (viewport.clientHeight - 2) * map.width / map.height))}px` : `${Number(zoom) * 100}%`;
  }
  function tokens() {
    const focusedOwner = document.activeElement?.dataset?.owner;
    $('map-tokens').replaceChildren();
    for (const token of map?.tokens || []) {
      const button = document.createElement('button'); button.type = 'button'; button.className = `map-token${token.concealed ? ' concealed' : ''}`;
      button.dataset.owner = token.ownerId; button.textContent = token.name.split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
      button.title = `${token.name}${token.concealed ? ' · hidden from players' : ''}`;
      button.setAttribute('aria-label', `${token.name}'s token${token.concealed ? ', concealed' : ''}`);
      button.disabled = !gm() && token.ownerId !== me()?.id;
      button.style.left = `${token.x * 100}%`; button.style.top = `${token.y * 100}%`;
      const colors = ['#a34b46', '#386a77', '#85713a', '#735c95', '#407654', '#99653d'];
      button.style.backgroundColor = colors[[...token.ownerId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length];
      button.addEventListener('keydown', event => {
        const delta = { ArrowLeft: [-.01, 0], ArrowRight: [.01, 0], ArrowUp: [0, -.01], ArrowDown: [0, .01] }[event.key];
        if (!delta || busy) return; event.preventDefault();
        change({ action: 'token', ownerId: token.ownerId, x: Math.max(0, Math.min(.999, token.x + delta[0])), y: Math.max(0, Math.min(.999, token.y + delta[1])) });
      });
      $('map-tokens').append(button);
      if (focusedOwner === token.ownerId) button.focus({ preventScroll: true });
    }
  }
  async function apply(next, epoch, owner) {
    if (epoch !== generation || owner !== me()?.id || !active) return;
    const hadMap = !!map;
    map = next.map;
    if (map && !hadMap) $('map-upload-details').open = false;
    controls();
    if (!map) { clearImage(); $('map-empty').textContent = gm() ? 'Upload a map to prepare your next scene.' : 'The GM has not shared a map yet.'; return; }
    const key = `${map.id}:${gm() ? 'gm' : map.imageRevision}`;
    if (imageKey !== key) {
      clearImage(); $('map-empty').textContent = 'Opening the map…';
      const query = new URLSearchParams({ id: map.id, version: map.imageRevision });
      const response = await fetch(`/api/map/image?${query}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) { if (response.status === 401) await api('/api/state'); throw new Error('The map changed while opening. Use Refresh to load it again.'); }
      const image = await createImageBitmap(await response.blob());
      if (epoch !== generation || owner !== me()?.id || !active) { image.close(); return; }
      bitmap = image; imageKey = key;
    }
    paint(); tokens(); $('map-surface').hidden = false; $('map-empty').hidden = true; fit();
  }
  async function refresh() {
    if (!active || !me()) return;
    const epoch = ++generation, owner = me().id;
    report();
    try { await apply(await api('/api/map'), epoch, owner); }
    catch (err) { if (epoch === generation && owner === me()?.id) report(err.message); }
  }
  async function change(body) {
    if (busy || !map || !me()) return;
    busy = true; controls(); report();
    const owner = me().id, epoch = ++generation;
    try {
      const result = await api('/api/map/action', { ...body, mapId: map.id, revision: map.revision });
      if (owner !== me()?.id) return;
      await apply(result, epoch, owner);
    } catch (err) { if (owner === me()?.id) { report(err.message); await refresh(); toast(err.message); } }
    finally { busy = false; controls(); }
  }
  function point(event) {
    const rect = $('map-surface').getBoundingClientRect();
    return { x: Math.max(0, Math.min(.999999, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(.999999, (event.clientY - rect.top) / rect.height)) };
  }
  $('map-surface').addEventListener('pointerdown', event => {
    if (busy || !map || event.button !== 0) return;
    const token = event.target.closest('[data-owner]');
    if (token && mode === 'move') { if (!gm() && token.dataset.owner !== me()?.id) return; gesture = { ownerId: token.dataset.owner, element: token, start: point(event), id: event.pointerId }; }
    else if (mode === 'place') { change({ action: 'token', ownerId: $('map-token-owner').value, ...point(event) }); return; }
    else if (gm() && ['reveal', 'hide'].includes(mode)) gesture = { start: point(event), id: event.pointerId };
    else return;
    event.preventDefault(); $('map-surface').setPointerCapture(event.pointerId);
  });
  $('map-surface').addEventListener('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const p = point(event);
    if (gesture.ownerId) { gesture.element.style.left = `${p.x * 100}%`; gesture.element.style.top = `${p.y * 100}%`; }
    else paint([gesture.start, p]);
  });
  $('map-surface').addEventListener('pointerup', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const finished = gesture, p = point(event); gesture = null;
    if (finished.ownerId) change({ action: 'token', ownerId: finished.ownerId, ...p });
    else {
      const x = Math.floor(Math.min(p.x, finished.start.x) * map.grid), y = Math.floor(Math.min(p.y, finished.start.y) * map.grid);
      change({ action: 'fog', mode, x, y, width: Math.floor(Math.max(p.x, finished.start.x) * map.grid) - x + 1, height: Math.floor(Math.max(p.y, finished.start.y) * map.grid) - y + 1 });
    }
  });
  for (const type of ['pointercancel', 'lostpointercapture']) $('map-surface').addEventListener(type, () => { if (gesture) { gesture = null; paint(); tokens(); } });
  document.querySelectorAll('[data-map-mode]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.mapMode; controls(); }));
  $('map-publish').addEventListener('click', () => change({ action: 'publish', published: !map?.published }));
  $('map-reveal-all').addEventListener('click', () => change({ action: 'reveal-all' }));
  $('map-hide-all').addEventListener('click', () => change({ action: 'hide-all' }));
  $('map-refresh').addEventListener('click', refresh);
  $('map-zoom').addEventListener('change', fit);
  new ResizeObserver(fit).observe($('map-viewport'));
  $('map-upload').addEventListener('submit', async event => {
    event.preventDefault(); if (!gm() || busy) return;
    const file = $('map-file').files[0], owner = me().id; if (!file) return;
    busy = true; controls(); report(); let image;
    try {
      if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 16 * 1024 * 1024) throw new Error('Choose a PNG or JPEG up to 16 MiB.');
      image = await createImageBitmap(file);
      const scale = Math.min(1, 4096 / image.width, 4096 / image.height, Math.sqrt(2_097_152 / (image.width * image.height)));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.floor(image.width * scale)); canvas.height = Math.max(1, Math.floor(image.height * scale)); canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); canvas.width = canvas.height = 0;
      if (owner !== me()?.id) return;
      if (!png || png.size > 8 * 1024 * 1024) throw new Error('This map is too detailed. Try a smaller image.');
      const query = new URLSearchParams({ title: $('map-title-input').value.trim(), ...(map ? { replace: map.id } : {}) });
      const response = await fetch(`/api/map/upload?${query}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/png' }, body: png });
      const result = await response.json();
      if (owner !== me()?.id) return;
      if (!response.ok) { if (response.status === 401) await api('/api/state'); throw new Error(result.error); }
      $('map-upload').reset(); $('map-upload-details').open = false;
      await apply(result, ++generation, owner); toast('Map prepared. Reveal terrain and choose Show to players when ready.');
    } catch (err) { if (owner === me()?.id) report(err.message); }
    finally { image?.close(); busy = false; controls(); }
  });
  function open() {
    if (!me()) return;
    active = true; $('map-window').hidden = false; $('restore-map').hidden = false;
    $('map-window').style.zIndex = '33'; $('hero-window').style.zIndex = '30'; $('dice-window').style.zIndex = '30'; $('diary-window').style.zIndex = '30';
    if (!map) $('map-upload-details').open = true;
    controls(); refresh(); $('map-refresh').focus({ preventScroll: true });
  }
  function close() { active = false; generation++; clearTimeout(refreshTimer); gesture = null; clearImage(); $('map-window').hidden = true; $('restore-map').hidden = true; if (me()) $('open-map').focus({ preventScroll: true }); }
  $('open-map').addEventListener('click', open); $('restore-map').addEventListener('click', open); $('close-map').addEventListener('click', close);
  $('maximize-map').addEventListener('click', () => { const on = $('map-window').classList.toggle('maximized'); $('maximize-map').setAttribute('aria-label', on ? 'Restore map window size' : 'Maximize map window'); });
  $('map-drag').addEventListener('pointerdown', event => {
    if (event.target.closest('button') || $('map-window').classList.contains('maximized') || event.button !== 0) return;
    const rect = $('map-window').getBoundingClientRect(); windowDrag = { id: event.pointerId, x: event.clientX - rect.x, y: event.clientY - rect.y }; $('map-drag').setPointerCapture(event.pointerId);
  });
  $('map-drag').addEventListener('pointermove', event => {
    if (!windowDrag || windowDrag.id !== event.pointerId) return;
    $('map-window').style.left = `${Math.max(8, Math.min(event.clientX - windowDrag.x, innerWidth - $('map-window').offsetWidth - 8))}px`;
    $('map-window').style.top = `${Math.max(8, Math.min(event.clientY - windowDrag.y, innerHeight - 100))}px`;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('map-drag').addEventListener(type, () => { windowDrag = null; });
  window.addEventListener('resize', () => { if (innerWidth <= 680) { $('map-window').style.left = ''; $('map-window').style.top = ''; } });
  return {
    changed({ image = true } = {}) {
      if (!active) return;
      if (image && !gm()) { generation++; clearImage(); $('map-empty').textContent = 'Updating the map…'; }
      clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 40);
    },
    reset() { close(); map = null; mode = 'move'; $('map-upload').reset(); $('map-token-owner').replaceChildren(); $('map-heading').textContent = ''; $('map-state').textContent = ''; $('map-empty').textContent = ''; report(); },
  };
}
