// Records the composer island's band frame by frame (CDP screencast) on the live-turn fixture (`pnpm fixtures`, after
// `pnpm build:test`): the lead's turn line coming, changing and going in the live strip, to check that its words move
// with what follows them. Each frame is a PNG with its compositor timestamp in frames.json, and box.json says where
// the band and the island are. `type` types in the composer meanwhile, `hover` moves the pointer over the strip.
//   node perf/band-frames.ts <out dir> <light|dark> <ms> [type|hover]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { devtoolsPort, launch, openChat, sleep } from "./app.ts";

const [out = "band", theme = "dark", ms = "9000", mode = ""] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const app = launch({ debug: true, env: { FLEETD_FIXTURE: "live-turn" } });
try {
  const port = await devtoolsPort(app);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => new URL(p.url()).pathname.endsWith("/index.html"));
  if (page === undefined) throw new Error("no app window");
  await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 760, deviceScaleFactor: 2, mobile: false });
  await openChat(page);
  const band = await page.locator("[data-band]").boundingBox();
  const frames: Array<{ t: number; file: string }> = [];
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const file = `f${String(frames.length).padStart(4, "0")}.png`;
    frames.push({ t: f.metadata.timestamp ?? 0, file });
    writeFileSync(path.join(out, file), Buffer.from(f.data, "base64"));
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 3000, maxHeight: 1520 });
  const end = Date.now() + Number(ms);
  if (mode === "type") {
    await page.getByLabel("Message the lead").click();
    while (Date.now() < end) {
      await page.keyboard.type("the quick brown fox ", { delay: 30 });
      for (let i = 0; i < 20; i++) await page.keyboard.press("Backspace");
    }
  } else if (mode === "hover") {
    while (Date.now() < end) {
      await page.mouse.move((band?.x ?? 0) + 400, (band?.y ?? 0) + 20);
      await sleep(300);
      await page.mouse.move((band?.x ?? 0) + 50, (band?.y ?? 0) - 200);
      await sleep(300);
    }
  } else await sleep(Number(ms));
  await cdp.send("Page.stopScreencast");
  writeFileSync(path.join(out, "box.json"), JSON.stringify({ band: await page.locator("[data-band]").boundingBox(), island: await page.locator("[data-band]").locator("..").boundingBox() }));
  writeFileSync(path.join(out, "frames.json"), JSON.stringify(frames));
  await browser.close();
} finally {
  await app.stop();
}
