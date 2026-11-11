// Heldenbau stays on its own origin; no RPG Projects credentials enter The Tavern.
export function setupHeroes({ getAccount, api, toast }) {
  const $ = id => document.getElementById(id);
  const generatorUrl = 'https://rpg-projects.vercel.app/projects/character-builder';
  let sheets = [], generation = 0, blobUrl, drag, selectedId, pdfPreview;
  const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  const release = () => { pdfPreview?.dispose(); pdfPreview = null; if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = null; $('hero-preview').replaceChildren(); };
  const accountId = () => getAccount()?.id;
  const audience = { private: 'Only me', gm: 'To GM', public: 'Public' };
  const error = message => { $('hero-error').textContent = message || ''; $('hero-error').hidden = !message; };

  async function preview(id) {
    const epoch = ++generation, owner = accountId();
    release(); error(); selectedId = id;
    const sheet = sheets.find(item => item.id === id);
    $('hero-description').textContent = sheet ? `${sheet.owner} · ${sheet.fileName} · ${audience[sheet.visibility]}` : 'Attach a Heldenbau hero file or a PDF to keep your sheet at this table.';
    $('hero-download').hidden = !sheet;
    if (!sheet) return;
    $('hero-preview').append(node('p', 'Opening your sheet…'));
    try {
      const response = await fetch(`/api/heroes/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error); }
      const blob = await response.blob();
      if (epoch !== generation || accountId() !== owner) return;
      blobUrl = URL.createObjectURL(blob);
      $('hero-download').href = blobUrl;
      $('hero-download').download = sheet.fileName;
      $('hero-preview').replaceChildren();
      if (sheet.mime === 'application/pdf') {
        const { PdfPreview } = await import('/pdf-preview.js');
        if (epoch !== generation || accountId() !== owner) return;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (epoch !== generation || accountId() !== owner) return;
        pdfPreview = new PdfPreview($('hero-preview'));
        await pdfPreview.load(bytes);
      } else {
        const hero = JSON.parse(await blob.text());
        if (epoch !== generation || accountId() !== owner) return;
        $('hero-preview').append(node('h3', [hero.name, hero.lastName].filter(Boolean).join(' ')), node('p', [hero.race, hero.culture, hero.profession].filter(value => typeof value === 'string').join(' · ')));
        const attributes = node('dl'); attributes.className = 'hero-attributes';
        for (const key of ['MU', 'KL', 'IN', 'CH', 'FF', 'GE', 'KO', 'KK']) { const item = node('div'); item.append(node('dt', key), node('dd', String(hero.attributes[key]))); attributes.append(item); }
        $('hero-preview').append(attributes, node('p', 'Imported base attributes. Open Heldenbau for the full sheet, calculated values and editing.'));
        const details = node('details'); details.append(node('summary', 'All saved character data'));
        const pre = node('pre', JSON.stringify(hero, null, 2)); details.append(pre); $('hero-preview').append(details);
      }
    } catch (err) { if (epoch === generation && accountId() === owner) { release(); error(err.message); } }
  }

  async function refresh() {
    const owner = accountId(), epoch = ++generation;
    error();
    try {
      const result = await api('/api/heroes');
      if (accountId() !== owner || epoch !== generation) return;
      sheets = result.sheets;
      const mine = sheets.find(sheet => sheet.ownerId === owner);
      $('hero-replacement').hidden = !mine;
      $('hero-replace').required = !!mine;
      $('hero-upload-button').textContent = mine ? 'Replace my sheet' : 'Attach my sheet';
      $('hero-list').replaceChildren();
      if (!sheets.length) { const option = node('option', 'No attached sheets yet'); option.value = ''; $('hero-list').append(option); }
      for (const sheet of sheets) { const option = node('option', `${sheet.owner}${sheet.ownerId === owner ? ' (you)' : ''} · ${sheet.fileName} · ${audience[sheet.visibility]}`); option.value = sheet.id; $('hero-list').append(option); }
      const selection = sheets.find(sheet => sheet.id === selectedId) || mine || sheets[0];
      $('hero-list').value = selection?.id || '';
      await preview(selection?.id);
    } catch (err) { if (accountId() === owner && epoch === generation) error(err.message); }
  }

  function open() {
    if (!accountId()) return;
    $('hero-window').hidden = false; $('restore-hero').hidden = false;
    $('hero-window').style.zIndex = '34'; $('dice-window').style.zIndex = '30'; $('map-window').style.zIndex = '30'; $('diary-window').style.zIndex = '30';
    refresh(); $('hero-list').focus({ preventScroll: true });
  }
  function close() { generation++; release(); $('hero-window').hidden = true; $('restore-hero').hidden = true; $('open-hero').focus({ preventScroll: true }); }
  $('open-hero').addEventListener('click', open); $('restore-hero').addEventListener('click', open);
  $('close-hero').addEventListener('click', close);
  $('maximize-hero').addEventListener('click', () => { const on = $('hero-window').classList.toggle('maximized'); $('maximize-hero').setAttribute('aria-label', on ? 'Restore hero window size' : 'Maximize hero window'); });
  $('hero-refresh').addEventListener('click', refresh);
  $('hero-list').addEventListener('change', () => preview($('hero-list').value));
  document.querySelectorAll('[data-hero-tab]').forEach(button => button.addEventListener('click', () => {
    const generator = button.dataset.heroTab === 'generator';
    $('hero-sheets-panel').hidden = generator; $('hero-generator-panel').hidden = !generator;
    document.querySelectorAll('[data-hero-tab]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
    if (generator && !$('hero-generator').hasAttribute('src')) $('hero-generator').src = generatorUrl;
  }));
  $('hero-upload').addEventListener('submit', async event => {
    event.preventDefault(); error();
    const owner = accountId(), file = $('hero-file').files[0];
    if (!owner || !file) return;
    const pdf = file.name.toLowerCase().endsWith('.pdf'), json = file.name.toLowerCase().endsWith('.json');
    if (!pdf && !json) { error('Choose a PDF or a Heldenbau JSON export.'); return; }
    if (file.size > (pdf ? 10 : 2) * 1024 * 1024) { error('PDFs can be up to 10 MiB; hero files up to 2 MiB.'); return; }
    $('hero-upload-button').disabled = true;
    try {
      const query = new URLSearchParams({ name: file.name, visibility: $('hero-visibility').value });
      const response = await fetch(`/api/hero?${query}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': pdf ? 'application/pdf' : 'application/json' }, body: file });
      const body = await response.json();
      if (owner !== accountId()) return;
      if (!response.ok) throw new Error(body.error);
      selectedId = body.sheet.id;
      $('hero-file').value = ''; $('hero-replace').checked = false;
      await refresh(); toast('Your character sheet is saved.');
    } catch (err) { if (owner === accountId()) error(err.message); }
    finally { $('hero-upload-button').disabled = false; }
  });
  $('hero-drag').addEventListener('pointerdown', event => {
    if (event.target.closest('button') || $('hero-window').classList.contains('maximized') || event.button !== 0) return;
    const rect = $('hero-window').getBoundingClientRect(); drag = { id: event.pointerId, x: event.clientX - rect.x, y: event.clientY - rect.y }; $('hero-drag').setPointerCapture(event.pointerId);
  });
  $('hero-drag').addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    $('hero-window').style.left = `${Math.max(8, Math.min(event.clientX - drag.x, innerWidth - $('hero-window').offsetWidth - 8))}px`;
    $('hero-window').style.top = `${Math.max(8, Math.min(event.clientY - drag.y, innerHeight - 100))}px`;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('hero-drag').addEventListener(type, () => { drag = null; });
  window.addEventListener('resize', () => { if (innerWidth <= 680) { $('hero-window').style.left = ''; $('hero-window').style.top = ''; } });
  return { reset() {
    generation++; sheets = []; selectedId = null; release();
    $('hero-window').hidden = true; $('restore-hero').hidden = true;
    $('hero-generator').removeAttribute('src'); $('hero-upload').reset();
    $('hero-list').replaceChildren(); $('hero-description').textContent = '';
    $('hero-download').hidden = true; $('hero-download').removeAttribute('href'); $('hero-download').removeAttribute('download');
    error();
  } };
}
