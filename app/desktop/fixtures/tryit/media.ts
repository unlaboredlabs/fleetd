// `node fixtures/tryit/media.ts`: renders the Try it fixture's frames once, into fixtures/tryit/media/: each page
// pages.ts draws as a 960×600 JPEG, as the preview's session streams them. The files are committed, so the fixture
// build needs no Electron. Run it again after changing a page.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { jpegsOf, launchCanvas, pixelsOnly } from "../sessions/media.ts";
import { PAGES } from "./pages.ts";

const OUT = path.join(import.meta.dirname, "media");

mkdirSync(OUT, { recursive: true });
const { app, win } = await launchCanvas();
try {
  const jpegs = await jpegsOf(win, PAGES);
  for (const [name, b64] of Object.entries(jpegs)) writeFileSync(path.join(OUT, `${name}.jpg`), pixelsOnly(Buffer.from(b64, "base64")));
} finally {
  await app.close();
}
