// `pnpm perf:record` (after `pnpm build:test`): the demo recording end to end, without a hub. The app records itself (FLEETD_RECORD) and types
// an order (FLEETD_DEMO_TYPE) into the stand-in composer; SIGUSR1 ends the clip as tests/lab/demoFanout.ts ends it,
// SIGTERM ends the run. Then both MP4s are checked: H.264, moov before the first fragment, and real frames; and the
// traffic lights, which the recorder paints on macOS, are forced on (FLEETD_RECORD_CHROME) and looked for in a still.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { devtoolsPort, launch, sleep } from "./app.ts";
import { summarize } from "./mp4.ts";
import { pixel } from "./png.ts";
import { COMPOSER } from "./targets.ts";

const ORDER = "@storefront Add a short page on what the merge train does.";
const out = mkdtempSync(path.join(tmpdir(), "fleetd-record-"));
const problems: Array<string> = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) problems.push(what);
};

const app = launch({ debug: true, env: { FLEETD_RECORD: `${out},30`, FLEETD_DEMO_TYPE: ORDER, FLEETD_RECORD_CHROME: "1" } });
try {
  const port = await devtoolsPort(app);
  await app.waitFor(/^FLEETD_RECORD start /u, 30_000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().endsWith("/index.html"));
    if (page === undefined) throw new Error("no app window over CDP");
    await COMPOSER.open(page);
    await app.waitFor(/^FLEETD_DEMO sent/u, 60_000);
    await sleep(1000);
    check((await page.getByText(ORDER, { exact: true }).count()) > 0, "the typed order was sent and shows in the log");
  } finally {
    await browser.close();
  }
  app.child.kill("SIGUSR1");
  await app.waitFor(/^FLEETD_RECORD clip_done /u, 20_000);
} finally {
  await app.stop();
}

for (const line of app.lines.filter((l) => /^FLEETD_(RECORD|DEMO) /u.test(l))) console.log(`  ${line}`);
check(app.lines.some((l) => l.startsWith("FLEETD_RECORD clip_start ")), "the clip opened before the first key");
check(app.lines.some((l) => l.startsWith("FLEETD_RECORD done ")), "SIGTERM finished the full recording");
check(!app.lines.some((l) => /^FLEETD_RECORD (clip_)?error=/u.test(l)), "no recorder errors");
for (const name of ["fleetd.mp4", "clip.mp4"]) {
  try {
    const mp4 = summarize(readFileSync(path.join(out, name)));
    console.log(`  ${name}: ${JSON.stringify(mp4)}`);
    check(mp4.codecs.includes("avc1"), `${name} is H.264`);
    check(mp4.boxes[0] === "ftyp" && mp4.boxes.indexOf("moov") < mp4.boxes.indexOf("moof"), `${name} has its moov before the first fragment`);
    check(mp4.frames >= 10, `${name} has frames (${mp4.frames})`);
  } catch (error) {
    check(false, `${name} reads as MP4: ${String(error)}`);
  }
}
const stills = readdirSync(path.join(out, "frames")).filter((f) => f.endsWith(".png"));
check(stills.length > 0, `stills in frames/ (${stills.length})`);
const last = stills.sort().at(-1);
if (last !== undefined) {
  // The close button's centre at the app's trafficLightPosition (16, 14), scale 1: (23, 22).
  const [r, g, b] = pixel(readFileSync(path.join(out, "frames", last)), 23, 22);
  check(r > 200 && g < 140 && b < 140, `the close button is painted in the still (rgb ${r},${g},${b})`);
}
rmSync(out, { recursive: true, force: true });
if (problems.length > 0) {
  console.log(`\n${problems.length} check(s) failed`);
  process.exitCode = 1;
}
