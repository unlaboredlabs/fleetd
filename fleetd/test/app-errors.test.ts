// `app_error_report`: the phone's errors land in the workspace's log, one line each with where they happened (screen,
// build, folded or not, the stack on the same line); a key sends at most an hour's worth; a malformed report is
// refused by its schema; fleetd's own workspace pulls a phone update whose reports spike (hub/app_errors/pull.ts).
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppErrorReport, AppErrorReportOutput } from "../src/shared/contracts.ts";
import { logLine, register, REPORTS_PER_HOUR } from "../src/hub/app_errors/tools.ts";
import { spike } from "../src/hub/app_errors/pull.ts";
import { type Caller, Registry } from "../src/hub/api/registry.ts";
import { testHub } from "./people-kit.ts";


const report = (over: Partial<AppErrorReport> = {}): AppErrorReport => ({
  at: "2026-11-26T19:18:20.000Z",
  build: "115",
  fatal: false,
  message: "TypeError: undefined is not a function",
  platform: "ios",
  stack: "TypeError: undefined is not a function\n    at Chats (index.bundle:1:2345)\n\n    in SwipingChat",
  wide: false,
  window: "466x678",
  screen: "Chats",
  update: "embedded",
  os: "27.1",
  device: "iPhone19,4",
  ...over,
});

let warned: string[] = [];
let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warned = [];
  warn = spyOn(console, "warn").mockImplementation((line: unknown) => void warned.push(String(line)));
});
afterEach(() => warn.mockRestore());

test("each report is one log line: who, the message, the screen, the window, the build and the stack", async () => {
  const kit = testHub();
  const phone = kit.device([{ role: "admin", machines: "*" }], undefined, "Ada's iPhone");
  const out = await kit.call<AppErrorReportOutput>(phone, "app_error_report", { errors: [report(), report({ fatal: true, wide: true, window: "951x678", screen: "Chat" })] });
  expect(out.kept).toBe(2);
  expect(warned).toHaveLength(2);
  expect(warned[0]).toStartWith("app error from Ada's iPhone");
  expect(warned[0]).toContain(": TypeError: undefined is not a function | screen Chats | narrow 466x678 | build 115 update embedded | ios 27.1 iPhone19,4");
  expect(warned[0]).toContain("| stack: TypeError: undefined is not a function ⏎ at Chats (index.bundle:1:2345) ⏎ in SwipingChat");
  expect(warned[0]).not.toContain("\n");
  expect(warned[1]).toStartWith("app error (fatal) from Ada's iPhone");
  expect(warned[1]).toContain("| screen Chat | wide 951x678 |");
});

test("a key's reports past an hour's worth are counted, not logged, and said once the next hour starts", async () => {
  const kit = testHub();
  const phone = kit.device();
  const batch = { errors: Array.from({ length: 20 }, () => report()) };
  let kept = 0;
  for (let i = 0; i < 4; i++) kept += (await kit.call<AppErrorReportOutput>(phone, "app_error_report", batch)).kept;
  expect(kept).toBe(REPORTS_PER_HOUR);
  expect(warned).toHaveLength(REPORTS_PER_HOUR);
  // Another key has its own hour.
  expect((await kit.call<AppErrorReportOutput>(kit.device(), "app_error_report", { errors: [report()] })).kept).toBe(1);
  kit.clock.advance(3_600_000);
  expect((await kit.call<AppErrorReportOutput>(phone, "app_error_report", { errors: [report()] })).kept).toBe(1);
  expect(warned).toContain("app error: 20 more from laptop in the hour before weren't logged");
});

test("a report the schema doesn't admit is refused, and nothing is logged", async () => {
  const kit = testHub();
  const phone = kit.device();
  for (const bad of [{ errors: [] }, { errors: [report({ window: "wide" })] }, { errors: [report({ message: "" })] }, { errors: Array.from({ length: 21 }, () => report()) }]) {
    await expect(kit.call(phone, "app_error_report", bad)).rejects.toThrow();
  }
  expect(warned).toHaveLength(0);
});

test("the log line keeps to one line whatever the message holds", () => {
  const line = logLine(report({ message: "Error:\n  two\tlines", stack: "" }), "phone");
  expect(line).toBe("app error from phone: Error: two lines | screen Chats | narrow 466x678 | build 115 update embedded | ios 27.1 iPhone19,4 | at 2026-11-26T19:18:20.000Z");
});

// fleetd's own workspace (update settings' ring "first" with reportTo) pulls a phone update whose reports spike.
const UPDATE = "11111111-2222-3333-4444-555555555555";
/** The pulls asked for, as "<repo> <update id>". */
const pulls: string[] = [];
function ownWorkspace(settings: object = { ring: "first", reportTo: "unlaboredlabs/fleetd" }) {
  const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "app-errors-"));
  mkdirSync(join(home, "update"));
  writeFileSync(join(home, "update", "settings.json"), JSON.stringify(settings));
  const kit = testHub({ home });
  // The tool with a pull that only notes what it was asked, never gh.
  const tools = new Registry();
  register(tools, async (repo, id) => void pulls.push(`${repo} ${id}`));
  const send = (caller: Caller, errors: AppErrorReport[]) => tools.call(kit.hub, caller, "app_error_report", { errors });
  return { home, kit, send };
}

test("on fleetd's own workspace, a fatal report on an over-the-air update pulls it from the rollout, once", async () => {
  pulls.length = 0;
  const { home, kit, send } = ownWorkspace();
  const phone = kit.device();
  await send(phone, [report({ update: UPDATE, fatal: true }), report({ update: UPDATE, fatal: true })]);
  await send(phone, [report({ update: UPDATE, fatal: true })]);
  await Bun.sleep(10);
  expect(pulls).toEqual([`unlaboredlabs/fleetd ${UPDATE}`]);
  expect(warned).toContain(`app error: pulling phone update ${UPDATE} (1 fatal error report)`);
  // Only counts are kept: no message, no stack.
  const kept = readFileSync(join(home, "update", "phone-errors.json"), "utf8");
  expect(kept).toContain(UPDATE);
  expect(kept).not.toContain("TypeError");
});

test("caught reports pull an update only past a few and at twice the rate of the one before", async () => {
  pulls.length = 0;
  const { kit, send } = ownWorkspace();
  const phone = kit.device();
  const before = "00000000-0000-4000-8000-000000000000";
  // The update before: 2 caught in the hour until the next one was first reported.
  await send(phone, Array.from({ length: 2 }, () => report({ update: before })));
  kit.clock.advance(3_600_000);
  // This one: 3 caught is never enough, whatever the rate; a 4th, far over 2 an hour, is.
  await send(phone, Array.from({ length: 3 }, () => report({ update: UPDATE })));
  await Bun.sleep(10);
  expect(pulls).toEqual([]);
  await send(phone, [report({ update: UPDATE })]);
  await Bun.sleep(10);
  expect(pulls).toEqual([`unlaboredlabs/fleetd ${UPDATE}`]);
  // A build's own bundle has nothing to pull.
  await send(phone, [report({ update: "embedded", fatal: true })]);
  await Bun.sleep(10);
  expect(pulls).toHaveLength(1);
});

test("any other workspace counts nothing and pulls nothing", async () => {
  pulls.length = 0;
  for (const settings of [{}, { ring: "first" }, { reportTo: "unlaboredlabs/fleetd" }]) {
    const { home, kit, send } = ownWorkspace(settings);
    await send(kit.device(), [report({ update: UPDATE, fatal: true })]);
    expect(existsSync(join(home, "update", "phone-errors.json"))).toBe(false);
  }
  await Bun.sleep(10);
  expect(pulls).toEqual([]);
});

test("an update's caught errors are weighed against the update before it, an hour's rate each", () => {
  const H = 3_600_000;
  const T = 1_792_000_000_000;
  const before = { id: "b", firstAt: T - 2 * H, fatal: 0, caught: 20 }; // 10 an hour over the 2 hours until `now`'s was first reported
  const now = (caught: number, fatal = 0) => [{ id: "u", firstAt: T, fatal, caught }, before];
  // 12 in an hour against 10 an hour: not twice.
  expect(spike(now(12), "u", T + H)).toBeUndefined();
  // 21 in an hour: over twice.
  expect(spike(now(21), "u", T + H)).toBe("21 caught errors, 21.0 an hour against 10.0 an hour on the update before");
  // Any fatal one, whatever came before; an update already pulled, never again.
  expect(spike(now(0, 1), "u", T + H)).toBe("1 fatal error report");
  expect(spike([{ id: "u", firstAt: T, fatal: 3, caught: 0, pulledAt: T }], "u", T + H)).toBeUndefined();
});
