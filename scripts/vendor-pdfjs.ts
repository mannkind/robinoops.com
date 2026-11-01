import { cp, mkdir } from 'node:fs/promises';

// PDF.js resolves these resources at runtime. Ship them with the site, never a CDN.
const target = new URL('../public/pdfjs/', import.meta.url);
await mkdir(target, { recursive: true });
for (const directory of ['standard_fonts', 'cmaps', 'wasm']) {
  await cp(new URL(`../node_modules/pdfjs-dist/${directory}/`, import.meta.url),
    new URL(`${directory}/`, target), { recursive: true });
}
await cp(new URL('../node_modules/pdfjs-dist/LICENSE', import.meta.url),
  new URL('LICENSE', target));

await cp(new URL('../node_modules/@noble/hashes/LICENSE', import.meta.url),
  new URL('../noble-hashes-LICENSE.txt', target));