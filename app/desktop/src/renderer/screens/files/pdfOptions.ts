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

/** pdf.js's operator codes, by name (its `OPS`). */
export type Ops = Readonly<Record<string, number>>;

/** Operators that put something on the page besides a picture XObject: paths, shadings, inline pictures, masks. */
const PAINTS = [
  "fill",
  "eoFill",
  "stroke",
  "closeStroke",
  "fillStroke",
  "eoFillStroke",
  "closeFillStroke",
  "closeEOFillStroke",
  "rawFillPath",
  "shadingFill",
  "paintInlineImageXObject",
  "paintInlineImageXObjectGroup",
  "paintImageMaskXObject",
  "paintImageMaskXObjectGroup",
  "paintImageMaskXObjectRepeat",
  "paintSolidColorImageMask",
] as const;

/**
 * Whether a page pdf.js drew without an error came out blank anyway: it paints only pictures, every one of them one
 * pdf.js couldn't decode (a damaged scan, a picture in a kind it can't read), and no words. pdf.js only warns of such a
 * picture and draws nothing in its place. A page with anything else on it (a picture that decoded, a path, a shading,
 * words) keeps showing, with its broken pictures left out.
 */
export async function blankForPictures(page: DrawnPage, ops: Ops): Promise<boolean> {
  const list = await page.getOperatorList();
  const paints = new Set<number>(PAINTS.flatMap((name) => (ops[name] === undefined ? [] : [ops[name]])));
  const pictures = new Set([ops["paintImageXObject"], ops["paintImageXObjectRepeat"]]);
  let drawn = 0;
  let lost = 0;
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i] as number;
    const args = list.argsArray[i] as readonly unknown[] | null | undefined;
    // A path is built and painted in one operator, its paint first among its arguments (none but a clip: endPath).
    if (fn === ops["constructPath"] ? args?.[0] !== ops["endPath"] : paints.has(fn)) return false;
    if (!pictures.has(fn)) continue;
    const name = args?.[0];
    if (typeof name !== "string") continue;
    // A picture shared across pages lives with the document's objects.
    const store = name.startsWith("g_") ? page.commonObjs : page.objs;
    if (store.has(name) && store.get(name) === null) lost += 1;
    else drawn += 1;
  }
  if (lost === 0 || drawn > 0) return false;
  return (await page.getTextContent()).items.length === 0;
}
