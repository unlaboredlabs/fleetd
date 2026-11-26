// `app_error_report`: the phone's errors land in the workspace's log, one line each with where they happened (screen,
// build, folded or not, the stack on the same line); a key sends at most an hour's worth; a malformed report is
// refused by its schema.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { AppErrorReport, AppErrorReportOutput } from "../src/shared/contracts.ts";
import { logLine, REPORTS_PER_HOUR } from "../src/hub/app_errors/tools.ts";
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
