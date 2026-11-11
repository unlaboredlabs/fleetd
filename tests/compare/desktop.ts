// `node desktop.ts [--impl <name>] [--bin <fleetd>]`: the desktop app's QA against a live hub of the fleetd under test,
// not a fixture. A throwaway fleet (hub, node, project, offline claude; fleet.ts) and the QA build of the app
// (app/desktop: `pnpm install && pnpm qa:build`) connected to it with FLEETD_HUB_URL and a human key. It opens each
// screen below by its hash route as the QA suite does (app/desktop/qa/harness.ts: show, settle, assertExpectedState,
// assertAlive, the DOM checks), screenshots it, and then does what only a live hub can answer: a chat message to the
// lead answered by the (stand-in) claude, and a writer spawned by the lead showing in the agents panel.
// Writes results/<impl>/desktop.json; the screenshots stay in the run's scratch directory, printed at the end.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { appMain, assertAlive, assertExpectedState, check as domChecks, desktopDir, settle } from "../../app/desktop/qa/harness.ts";
import { withFleet } from "./fleet.ts";
import { scratch, target, writeResult } from "./lib.ts";

const { _electron: electron } = createRequire(path.join(desktopDir, "package.json"))("@playwright/test") as typeof import("@playwright/test");
const { name, bin } = target();
if (!fs.existsSync(appMain)) throw new Error(`${appMain} is missing: run \`pnpm install && pnpm qa:build\` in app/desktop first`);
const run = scratch(`qa-${name}`);
const shots = path.join(run, "shots");
fs.mkdirSync(shots, { recursive: true });

interface Row {
  readonly step: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: string;
  readonly findings?: number;
}
const rows: Array<Row> = [];

await withFleet(path.join(run, "f"), bin, async (fleet) => {
  const { f } = fleet;
  const { machineId, projectId } = f.ref;
  const userData = path.join(run, "user-data");
  const env: Record<string, string> = {
    FLEETD_HUB_URL: f.hubUrl,
    FLEETD_AGENT_KEY: fleet.humanKey,
    FLEETD_HOME: path.join(userData, "fleetd"),
    HOME: process.env.HOME ?? userData,
    PATH: process.env.PATH ?? "",
    LANG: "en_US.UTF-8",
    TZ: "UTC",
  };
  for (const key of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key]!;
  const args = [appMain, `--user-data-dir=${userData}`, "--lang=en-US", "--no-sandbox"];
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) args.push("--ozone-platform=headless");
  const app = await electron.launch({ args, env, cwd: desktopDir, timeout: 60_000 });
  const page = await app.firstWindow();
  const errors: Array<string> = [];
  const consoleErrors: Array<string> = [];
  page.on("pageerror", (e) => errors.push(`${e.name}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().split("\n")[0] ?? "");
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const step = async (label: string, body: () => Promise<number | void>) => {
    const t0 = performance.now();
    const before = errors.length;
    try {
      const findings = await body();
      const thrown = errors.slice(before);
      if (thrown.length > 0) throw new Error(`the page threw: ${thrown.join("; ")}`);
      rows.push({ step: label, ok: true, ms: Math.round(performance.now() - t0), ...(typeof findings === "number" ? { findings } : {}) });
      console.log(`pass ${label}`);
    } catch (e) {
      rows.push({ step: label, ok: false, ms: Math.round(performance.now() - t0), detail: String(e instanceof Error ? e.message : e).slice(0, 600) });
      console.log(`FAIL ${label}: ${String(e).slice(0, 600)}`);
    }
    await page.screenshot({ path: path.join(shots, `${String(rows.length).padStart(2, "0")}-${label.replace(/[^a-z0-9]+/giu, "-")}.png`) }).catch(() => undefined);
  };
  try {
    await step("connects and shows the shell", async () => {
      await page.locator("[data-screen]").first().waitFor({ state: "visible", timeout: 60_000 });
      await settle(page);
      await assertAlive(page, { id: "shell" }, errors);
    });
    const CHAT = `#/project/${machineId}/${projectId}`;
    const routes: Array<[string, string]> = [
      ["home", "#/"],
      ["project chat", CHAT],
      ["agents panel", `${CHAT}/agents`],
      ["sessions panel", `${CHAT}/sessions`],
      ["checklist panel", `${CHAT}/checklist`],
      ["artifacts panel", `${CHAT}/artifacts`],
      ["status", "#/status"],
      ["factory", "#/factory"],
      ["agent time", "#/factory/time"],
      ["screens", "#/screens"],
      ["settings general", "#/settings/general"],
      ["settings project", `#/settings/projects?for=${machineId}/${projectId}`],
      ["settings agents", `#/settings/agents?for=${machineId}/${projectId}`],
      ["settings devices", "#/settings/devices"],
      ["hub machines", "#/settings/hub/machines"],
      ["hub machine", `#/settings/hub/machines/${machineId}`],
      ["hub people", "#/settings/hub/people"],
      ["hub profiles", "#/settings/hub/profiles"],
      ["hub tools", "#/settings/hub/tools"],
      ["hub setup", "#/settings/hub/setup"],
    ];
    for (const [label, route] of routes) {
      await step(`screen: ${label}`, async () => {
        await page.evaluate((r) => {
          window.location.hash = r;
        }, route);
        await page.locator("[data-screen]").first().waitFor({ state: "visible", timeout: 15_000 });
        await settle(page);
        await assertExpectedState(page, { id: label });
        await assertAlive(page, { id: label }, errors);
        return (await domChecks(page, [])).length;
      });
    }
    await step("chat: a message to the lead is answered", async () => {
      await page.evaluate((r) => {
        window.location.hash = r;
      }, CHAT);
      const box = page.getByRole("textbox", { name: "Message the lead" });
      await box.waitFor({ timeout: 30_000 });
      await box.fill("compare QA: say hello");
      await box.press("Enter");
      await page.getByText("lab-ok").first().waitFor({ state: "visible", timeout: 120_000 });
    });
    await step("agents: a spawned writer shows in the panel", async () => {
      const ws = f.workstream("Desktop QA order.");
      // Slow between its two calls, so it is still at work while the panel is read.
      f.spawnWriter(ws, "compare QA writer", "Say hi.\nlab-slow: 90000\nlab-run: echo hi\nlab-run: echo again");
      await page.evaluate((r) => {
        window.location.hash = r;
      }, `${CHAT}/agents`);
      await page.getByText("compare QA writer").first().waitFor({ state: "visible", timeout: 60_000 });
    });
  } finally {
    await app.close().catch(() => undefined);
  }
  rows.push({ step: "console errors (not failed on)", ok: true, ms: 0, detail: [...new Set(consoleErrors)].slice(0, 20).join(" | ") });
});

const failed = rows.filter((r) => !r.ok);
writeResult(name, "desktop", { passed: rows.length - failed.length, failed: failed.length, steps: rows }, bin);
console.log(`${rows.length - failed.length} of ${rows.length} desktop steps passed; screenshots: ${shots}`);
process.exitCode = failed.length === 0 ? 0 : 1;
