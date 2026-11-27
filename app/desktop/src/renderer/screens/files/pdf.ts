// pdf.js, loaded the first time a PDF opens, its worker a module from the app's own origin (the page's policy allows
// workers from 'self' and nothing else). The document is read through a range transport: pdf.js asks for the byte
// ranges it needs (the cross-reference table at the end, then each page as it is drawn) and the file source reads
// just those from the workspace (source.ts), so a 25 MB scan shows its first page without its last. Its image decoders
// (JBIG2 and fax, JPEG 2000: scripts/pdfjsDecoders.ts) sit in `pdfjs/` beside the built worker, in their plain-module
// builds (pdfOptions.ts); while developing, the package's own `wasm/`.
import { GlobalWorkerOptions, getDocument, PDFDataRangeTransport, TextLayer, type PDFDocumentProxy } from "pdfjs-dist";
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { pdfOptions } from "./pdfOptions";
import type { FileSource } from "./source";

GlobalWorkerOptions.workerSrc = worker;

export { TextLayer };
export type { PDFDocumentProxy };

/** Where pdf.js imports its image decoders from by name: a scan's pages draw blank without them. */
const WASM_URL = new URL(import.meta.env.DEV ? "../wasm/" : "pdfjs/", new URL(worker, document.baseURI)).href;

export function openPdf(source: FileSource, size: number, first: Uint8Array): { readonly doc: Promise<PDFDocumentProxy>; readonly close: () => void } {
  // Copies: pdf.js hands its buffers to the worker, which would empty the source's own.
  const transport = new PDFDataRangeTransport(size, first.slice(), size <= first.length);
  transport.requestDataRange = (begin: number, end: number) => {
    source.range(begin, end - begin).then(
      (chunk) => transport.onDataRange(begin, chunk.slice()),
      () => transport.abort(),
    );
  };
  const task = getDocument({ range: transport, ...pdfOptions(WASM_URL) });
  return { doc: task.promise, close: () => void task.destroy() };
}
