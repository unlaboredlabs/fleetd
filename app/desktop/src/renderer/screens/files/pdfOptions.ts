// How pdf.js opens a chat's PDF (pdf.ts), apart from where its bytes come from: pure, so a test opens a real scan with
// the same options. `wasmUrl` is the folder its image decoders are imported from by name (scripts/pdfjsDecoders.ts),
// in their plain-module builds: the page's policy compiles no WebAssembly. Without it a scan's pages draw blank.

/** How much pdf.js asks for at a time: a page or two of a scan, a whole short text document. */
export const PDF_CHUNK = 256 * 1024;

export const pdfOptions = (wasmUrl: string) =>
  ({ wasmUrl, useWasm: false, rangeChunkSize: PDF_CHUNK, disableAutoFetch: true, disableStream: true, useSystemFonts: true, enableXfa: false }) as const;

/** What `blankForPictures` reads of a drawn page: pdf.js's page, its operators' codes passed in. */
export interface DrawnPage {
  getOperatorList(): Promise<{ fnArray: readonly number[]; argsArray: readonly unknown[] }>;
  getTextContent(): Promise<{ items: readonly unknown[] }>;
  readonly objs: { has(id: string): boolean; get(id: string): unknown };
  readonly commonObjs: { has(id: string): boolean; get(id: string): unknown };
}

/**
 * Whether a page pdf.js drew without an error came out blank anyway: pictures it couldn't decode (a damaged scan, a
 * picture in a kind it can't read) and no words. pdf.js only warns of such a picture and draws nothing in its place.
 * A page with words keeps showing, with its broken picture left out.
 */
export async function blankForPictures(page: DrawnPage, ops: { readonly paintImageXObject: number; readonly paintImageXObjectRepeat: number }): Promise<boolean> {
  const list = await page.getOperatorList();
  let lost = 0;
  list.fnArray.forEach((fn, i) => {
    if (fn !== ops.paintImageXObject && fn !== ops.paintImageXObjectRepeat) return;
    const name = (list.argsArray[i] as readonly unknown[] | undefined)?.[0];
    if (typeof name !== "string") return;
    // A picture shared across pages lives with the document's objects.
    const store = name.startsWith("g_") ? page.commonObjs : page.objs;
    if (store.has(name) && store.get(name) === null) lost += 1;
  });
  if (lost === 0) return false;
  return (await page.getTextContent()).items.length === 0;
}
