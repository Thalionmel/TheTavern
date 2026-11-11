import { build } from 'esbuild';
import { cp, mkdir, readFile } from 'node:fs/promises';

await build({ entryPoints: ['client/dice3d.mjs'], bundle: true, minify: true, format: 'esm', target: 'es2022', legalComments: 'linked', outfile: 'public/dice3d.js' });
const pdfSource = await readFile('node_modules/pdfjs-dist/build/pdf.mjs', 'utf8');
const pdfNotice = pdfSource.slice(0, pdfSource.indexOf('*/') + 2);
await build({ entryPoints: ['client/pdf-preview.mjs'], bundle: true, minify: true, format: 'esm', target: 'es2022', legalComments: 'linked', banner: { js: pdfNotice }, outfile: 'public/pdf-preview.js' });
await mkdir('public/pdfjs', { recursive: true });
await cp('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'public/pdfjs/pdf.worker.mjs');
await cp('node_modules/pdfjs-dist/LICENSE', 'public/pdfjs/LICENSE');
for (const directory of ['standard_fonts', 'cmaps']) await cp(`node_modules/pdfjs-dist/${directory}`, `public/pdfjs/${directory}`, { recursive: true });
