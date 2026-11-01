import { getDocument, GlobalWorkerOptions, Util } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PageViewport } from 'pdfjs-dist';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { parseLines, reconcile } from './converter.ts';
import type { Statement } from './converter.ts';

GlobalWorkerOptions.workerSrc = workerUrl;

interface Fragment {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Row {
  y: number;
  fragments: Fragment[];
}

// PDF content streams often list entire columns before the next column.
// Sort rendered baselines first, then horizontal positions within each line.
export function reconstructLines(items: readonly (TextItem | TextMarkedContent)[], viewport: PageViewport): string[] {
  const fragments: Fragment[] = items.filter((item): item is TextItem => 'str' in item && typeof item.str === 'string' && Boolean(item.str.trim())).map(item => {
    const transform: readonly unknown[] = Util.transform(viewport.transform, item.transform);
    const [, , horizontal, vertical, x, y] = transform;
    if (typeof horizontal !== 'number' || typeof vertical !== 'number' || typeof x !== 'number' || typeof y !== 'number') {
      throw new Error('This PDF contains an invalid text transformation.');
    }
    return { text: item.str, x, y, width: item.width * viewport.scale,
      height: Math.hypot(horizontal, vertical) };
  }).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Row[] = [];
  for (const fragment of fragments) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - fragment.y) < 3 * viewport.scale) row.fragments.push(fragment);
    else rows.push({ y: fragment.y, fragments: [fragment] });
  }
  return rows.map(row => {
    row.fragments.sort((a, b) => a.x - b.x);
    let text = '';
    let previous: Fragment | undefined;
    for (const fragment of row.fragments) {
      // Retain split glyph runs without inserting spaces inside words.
      const gap = previous ? fragment.x - (previous.x + previous.width) : 0;
      if (previous && gap > Math.min(previous.height, fragment.height) * 0.15 && !/\s$/.test(text) && !/^\s/.test(fragment.text)) text += ' ';
      text += fragment.text;
      previous = fragment;
    }
    return text.replace(/\s+/g, ' ').trim();
  });
}

export async function extractStatement(arrayBuffer: ArrayBuffer): Promise<Statement> {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength === 0) throw new Error('Choose a non-empty PDF statement.');
  // Absolute URLs keep worker fetches relative to the site, not its assets/ folder.
  const assetBase = new URL(`${import.meta.env.BASE_URL}pdfjs/`, globalThis.document.baseURI).href;
  const loadingTask: PDFDocumentLoadingTask = getDocument({
    data: new Uint8Array(arrayBuffer),
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    wasmUrl: `${assetBase}wasm/`,
    useSystemFonts: false,
    stopAtErrors: true,
  });
  const lines: string[] = [];
  try {
    const document = await loadingTask.promise;
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        lines.push(...reconstructLines(content.items, page.getViewport({ scale: 1 })));
      } finally {
        page.cleanup();
      }
    }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'PasswordException') throw new Error('This PDF is password-protected. Unlock it locally before converting.', { cause: error });
    throw new Error('This PDF could not be read. Choose an undamaged Robinhood credit card statement PDF.', { cause: error });
  } finally {
    await loadingTask.destroy();
  }
  if (!lines.some(line => line.trim())) throw new Error('This PDF has no selectable text. Scanned or image-only statements are not supported.');
  const statement = parseLines(lines);
  reconcile(statement);
  return statement;
}
