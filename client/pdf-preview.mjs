import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';

GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';
const node = (tag, text) => { const el = document.createElement(tag); if (text) el.textContent = text; return el; };

// Paint one page at a time. PDF scripts, attachments and external links are never executed.
export class PdfPreview {
  constructor(container) {
    this.container = container; this.page = 1; this.disposed = false;
    this.toolbar = node('div'); this.toolbar.className = 'pdf-toolbar';
    this.previous = node('button', '← Previous'); this.next = node('button', 'Next →'); this.status = node('span', 'Opening PDF…');
    for (const button of [this.previous, this.next]) { button.type = 'button'; button.className = 'secondary'; button.disabled = true; }
    this.toolbar.append(this.previous, this.status, this.next);
    this.canvas = node('canvas'); this.canvas.className = 'pdf-page'; this.canvas.setAttribute('role', 'img');
    this.text = node('p'); this.text.className = 'sr-only';
    container.append(this.toolbar, this.canvas, this.text);
    this.previous.addEventListener('click', () => this.render(this.page - 1));
    this.next.addEventListener('click', () => this.render(this.page + 1));
  }
  async load(bytes) {
    if (this.disposed) return;
    this.loading = getDocument({ data: bytes, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', useWasm: false, disableFontFace: true, maxImageSize: 16_000_000, canvasMaxAreaInBytes: 32_000_000, enableXfa: false });
    this.document = await this.loading.promise;
    if (!this.disposed) await this.render(1);
  }
  async render(number) {
    if (this.disposed || this.rendering || number < 1 || number > this.document.numPages) return;
    this.rendering = true; this.previous.disabled = this.next.disabled = true;
    try {
      const page = await this.document.getPage(number);
      if (this.disposed) return;
      const base = page.getViewport({ scale: 1 });
      const width = Math.min(1000, Math.max(280, this.container.clientWidth));
      const scale = Math.min(width / base.width * Math.min(devicePixelRatio || 1, 1.5), Math.sqrt(2_000_000 / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      this.canvas.width = Math.ceil(viewport.width); this.canvas.height = Math.ceil(viewport.height);
      this.canvas.setAttribute('aria-label', `Character sheet, page ${number} of ${this.document.numPages}`);
      this.task = page.render({ canvasContext: this.canvas.getContext('2d'), viewport });
      await this.task.promise;
      if (this.disposed) return;
      this.page = number; this.status.textContent = `Page ${number} of ${this.document.numPages}`;
      const content = await page.getTextContent();
      if (!this.disposed) this.text.textContent = content.items.map(item => item.str || '').join(' ');
      page.cleanup();
    } catch (err) { if (!this.disposed) this.status.textContent = 'Preview unavailable. Use Download file.'; }
    finally { this.rendering = false; if (!this.disposed) { this.previous.disabled = this.page <= 1; this.next.disabled = this.page >= this.document.numPages; } }
  }
  dispose() { this.disposed = true; this.task?.cancel(); this.loading?.destroy().catch(() => {}); this.canvas.width = this.canvas.height = 0; }
}
