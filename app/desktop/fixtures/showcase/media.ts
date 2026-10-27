// `node fixtures/showcase/media.ts`: renders the showcase's screens once, into fixtures/showcase/media/: the web shop's
// pages as 960×600 JPEGs, as a browser session streams them, and the phone's as 480×1039, a simulator's portrait
// screen. The files are committed, so the fixture build needs no Electron. Run it again after changing a page.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { jpegsOf, launchCanvas, pixelsOnly } from "../sessions/media.ts";
import { PHONE, PHONE_FRAME, WEB } from "./pages.ts";

const OUT = path.join(import.meta.dirname, "media");

const render = async (pages: Readonly<Record<string, string>>, size?: { width: number; height: number }) => {
  const { app, win } = await launchCanvas(size?.width, size?.height);
  try {
    const jpegs = await jpegsOf(win, pages);
    for (const [name, b64] of Object.entries(jpegs)) writeFileSync(path.join(OUT, `${name}.jpg`), pixelsOnly(Buffer.from(b64, "base64")));
  } finally {
    await app.close();
  }
};

if (path.resolve(process.argv[1] ?? "") === import.meta.filename) {
  mkdirSync(OUT, { recursive: true });
  await render(WEB);
  await render(PHONE, PHONE_FRAME);
}
