// A scanned PDF's page decodes with the options the app opens PDFs with: its CCITT fax image (what office scanners
// write) comes through pdf.js's plain-module decoder, imported from the folder the build ships it in
// (scripts/pdfjsDecoders.ts). Without that folder the image is never decoded and the page draws blank.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { PDFJS_DECODERS } from "../../../shared/pdfjs";
import { pdfOptions } from "./pdfOptions";

/** One 200 × 100 page: a CCITT G4 image of a black box on white, as a scanner writes it. */
const SCAN = "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMTAwXSAvUmVzb3VyY2VzIDw8IC9YT2JqZWN0IDw8IC9JbTAgNCAwIFIgPj4gPj4gL0NvbnRlbnRzIDUgMCBSID4+CmVuZG9iago0IDAgb2JqCjw8IC9UeXBlIC9YT2JqZWN0IC9TdWJ0eXBlIC9JbWFnZSAvV2lkdGggMjAwIC9IZWlnaHQgMTAwIC9CaXRzUGVyQ29tcG9uZW50IDEgL0NvbG9yU3BhY2UgL0RldmljZUdyYXkgL0ZpbHRlciAvQ0NJVFRGYXhEZWNvZGUgL0RlY29kZVBhcm1zIDw8IC9LIC0xIC9Db2x1bW5zIDIwMCAvUm93cyAxMDAgL0JsYWNrSXMxIHRydWUgPj4gL0xlbmd0aCA1MCA+PgpzdHJlYW0KJqGSL//////yGiQ3///////////////////////////////////////4//////8AEAEKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMzAgPj4Kc3RyZWFtCnEgMjAwIDAgMCAxMDAgMCAwIGNtIC9JbTAgRG8gUQplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0NSAwMDAwMCBuIAowMDAwMDAwNTMwIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNjEwCiUlRU9GCg==";

const pdfjs = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const wasm = pathToFileURL(join(pdfjs, "wasm") + "/").href;

/** The page's one picture, as pdf.js decoded it: null when it couldn't. */
const decoded = async (wasmUrl: string | undefined) => {
  // The legacy build: Node lacks a few of the newest built-ins the modern build calls.
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = Uint8Array.from(atob(SCAN), (c) => c.charCodeAt(0));
  const task = getDocument({ data, ...pdfOptions(wasmUrl as string), verbosity: 0 });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const ops = await page.getOperatorList();
    const args = ops.argsArray[ops.fnArray.indexOf(OPS.paintImageXObject)] as readonly unknown[];
    const name = String(args[0]);
    // Pictures resolve after the operator list, decoded or not.
    return await new Promise<{ width: number; height: number } | null>((done) => {
      page.objs.get(name, (image: unknown) => done(image as { width: number; height: number } | null));
    });
  } finally {
    await task.destroy();
  }
};

it("decodes a scan's fax image with the decoders the build ships", async () => {
  const image = await decoded(wasm);
  expect(image).toMatchObject({ width: 200, height: 100 });
});

it("needs the decoders: with no folder for them the scan's image is never decoded", async () => {
  expect(await decoded(undefined)).toBeNull();
});

it("ships each decoder pdf.js imports by name", async () => {
  const { readFile } = await import("node:fs/promises");
  const worker = await readFile(join(pdfjs, "build", "pdf.worker.mjs"), "utf8");
  const named = [...worker.matchAll(/_noWasmFilename = "([^"]+)"/gu)].map((m) => m[1]);
  expect([...PDFJS_DECODERS].sort()).toEqual([...new Set(named)].sort());
});
