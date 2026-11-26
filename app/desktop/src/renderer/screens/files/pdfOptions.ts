// How pdf.js opens a chat's PDF (pdf.ts), apart from where its bytes come from: pure, so a test opens a real scan with
// the same options. `wasmUrl` is the folder its image decoders are imported from by name (scripts/pdfjsDecoders.ts),
// in their plain-module builds: the page's policy compiles no WebAssembly. Without it a scan's pages draw blank.

/** How much pdf.js asks for at a time: a page or two of a scan, a whole short text document. */
export const PDF_CHUNK = 256 * 1024;

export const pdfOptions = (wasmUrl: string) =>
  ({ wasmUrl, useWasm: false, rangeChunkSize: PDF_CHUNK, disableAutoFetch: true, disableStream: true, useSystemFonts: true, enableXfa: false }) as const;
