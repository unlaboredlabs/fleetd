// A build plugin that ships pdf.js's image decoders with the renderer (screens/files/pdf.ts): JBIG2 and CCITT fax (the
// black-and-white of every office scanner) and JPEG 2000. pdf.js imports them by name from the folder its `wasmUrl`
// names, so they keep their names, in `assets/pdfjs/` beside the worker. Without them a scan's pages draw blank. Only
// their plain-module builds: the page's policy lets no WebAssembly compile and no fetch, and these load by import().
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { PDFJS_DECODERS } from "../src/shared/pdfjs.ts";

export const pdfjsDecoders = (): Plugin => ({
  name: "fleetd-pdfjs-decoders",
  apply: "build",
  generateBundle() {
    const wasm = join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "wasm");
    for (const name of PDFJS_DECODERS) this.emitFile({ type: "asset", fileName: `assets/pdfjs/${name}`, source: readFileSync(join(wasm, name)) });
  },
});
