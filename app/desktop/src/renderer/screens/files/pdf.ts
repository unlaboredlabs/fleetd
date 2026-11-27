// pdf.js, loaded the first time a PDF opens, its worker a module from the app's own origin (the page's policy allows
// workers from 'self' and nothing else). The document is read through a range transport: pdf.js asks for the byte
// ranges it needs (the cross-reference table at the end, then each page as it is drawn) and the file source reads
// just those from the workspace (source.ts), so a 25 MB scan shows its first page without its last. Its image decoders
// (JBIG2 and fax, JPEG 2000: scripts/pdfjsDecoders.ts) sit in `pdfjs/` beside the built worker, in their plain-module
// builds (pdfOptions.ts); while developing, the package's own `wasm/`.
import { GlobalWorkerOptions, getDocument, OPS, PDFDataRangeTransport, TextLayer, type PDFDocumentProxy } from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { blankForPictures, pdfOptions, type DrawnPage } from "./pdfOptions";
import type { FileSource } from "./source";

GlobalWorkerOptions.workerSrc = worker;

export { TextLayer };

/** Whether a page drew blank for pictures pdf.js couldn't decode (pdfOptions.ts). */
export const drewBlank = (page: DrawnPage): Promise<boolean> => blankForPictures(page, OPS);
export type { PDFDocumentProxy };

/** Where pdf.js imports its image decoders from by name: a scan's pages draw blank without them. */
const WASM_URL = new URL(import.meta.env.DEV ? "../wasm/" : "pdfjs/", new URL(worker, document.baseURI)).href;

/**
 * The document, read by range. `failed` hears a range the workspace couldn't give. pdf.js waits on it (the page it
 * belongs to undrawn) rather than ending the document, so the pages already read stay; `retry` asks for every range
 * that failed again, and a page waiting on one draws once it comes.
 */
export function openPdf(
  source: FileSource,
  size: number,
  first: Uint8Array,
  failed: () => void = () => undefined,
): { readonly doc: Promise<PDFDocumentProxy>; readonly retry: () => void; readonly close: () => void } {
  // Copies: pdf.js hands its buffers to the worker, which would empty the source's own.
  const transport = new PDFDataRangeTransport(size, first.slice(), size <= first.length);
  let missed: (readonly [number, number])[] = [];
  const read = (begin: number, end: number) => {
    source.range(begin, end - begin).then(
      (chunk) => transport.onDataRange(begin, chunk.slice()),
      () => {
        missed.push([begin, end]);
        failed();
      },
    );
  };
  transport.requestDataRange = read;
  const task = getDocument({ range: transport, ...pdfOptions(WASM_URL) });
  const retry = () => {
    const again = missed;
    missed = [];
    for (const [begin, end] of again) read(begin, end);
  };
  return { doc: task.promise, retry, close: () => void task.destroy() };
}
