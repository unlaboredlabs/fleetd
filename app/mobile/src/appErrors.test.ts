// The app's errors for the workspace's log (appErrors.ts): a report says where (screen, folded or not, build) and the
// stack, never quoted text; it is on disk before it is sent, a fatal one waits for the next start, and one the link
// dropped goes again while one the workspace can't take doesn't.
import { describe, expect, it } from "vitest";
import type { AppErrorReport } from "./desktop";
import { keeper, parsePending, PENDING_MAX, queued, RECOVER_AFTER_MS, RECOVER_GAP_MS, recovers, reportOf, scrub, sendAgain, type Build, type Send } from "./appErrors";

const BUILD: Build = { platform: "ios", build: "115", update: "embedded", os: "27.1", device: "iPhone19,4" };
const FOLDED = { width: 466.3, height: 678 };
const OPEN = { width: 951, height: 678 };
const NOW = Date.parse("2026-11-26T19:18:20Z");

describe("A report", () => {
  it("says the error, where it was and on which build", () => {
    const error = new TypeError("Cannot read property 'title' of undefined");
    error.stack = "TypeError: Cannot read property 'title' of undefined\n    at Chats (index.bundle:1:2345)";
    const r = reportOf(error, { fatal: false, screen: "Home", componentStack: "\n    in SwipingChat\n    in Chats", window: FOLDED }, BUILD, NOW);
    expect(r).toEqual({
      at: "2026-11-26T19:18:20.000Z",
      build: "115",
      fatal: false,
      message: "TypeError: Cannot read property 'title' of undefined",
      platform: "ios",
      stack: "TypeError: Cannot read property 'title' of undefined\n    at Chats (index.bundle:1:2345)\n\n    in SwipingChat\n    in Chats",
      wide: false,
      window: "466x678",
      screen: "Home",
      update: "embedded",
      os: "27.1",
      device: "iPhone19,4",
    } satisfies AppErrorReport);
  });

  it("is wide on two panes, the Duo unfolded", () => {
    expect(reportOf(new Error("x"), { fatal: true, window: OPEN }, BUILD, NOW)).toMatchObject({ wide: true, window: "951x678", fatal: true });
  });

  it("names a stack frame's file without the app's install folder", () => {
    const error = new Error("x");
    error.stack = "Error: x\n    at Chats (/private/var/containers/Bundle/Application/0F3A-11/fleetd.app/main.jsbundle:211052:71)\n    at anonymous (address at index.android.bundle:1:9)";
    expect(reportOf(error, { fatal: false, window: FOLDED }, BUILD, NOW).stack).toBe("Error: x\n    at Chats (main.jsbundle:211052:71)\n    at anonymous (address at index.android.bundle:1:9)");
  });

  it("keeps no quoted text longer than a name, in the message or the stack", () => {
    const words = "JSON Parse error: Unexpected token in \"meet me at the station at nine, love\"";
    expect(scrub(words)).toBe("JSON Parse error: Unexpected token in \"…\"");
    expect(scrub("Cannot read property 'title' of undefined")).toBe("Cannot read property 'title' of undefined");
    const error = new Error(words);
    const r = reportOf(error, { fatal: false, window: FOLDED }, BUILD, NOW);
    expect(r.message).not.toContain("station");
    expect(r.stack).not.toContain("station");
  });

  it("keeps a message short and on one line, and names what isn't an Error", () => {
    const r = reportOf(new Error(`${"a".repeat(400)}\nb`), { fatal: false, window: FOLDED }, BUILD, NOW);
    expect(r.message.length).toBeLessThanOrEqual(300);
    expect(r.message).not.toContain("\n");
    expect(reportOf(42, { fatal: false, window: FOLDED }, BUILD, NOW).message).toBe("A value that isn't an Error was thrown");
    expect(reportOf("thrown words", { fatal: false, window: FOLDED }, BUILD, NOW).message).toBe("thrown words");
  });
});

describe("What waits on the phone", () => {
  const r = (message: string) => reportOf(new Error(message), { fatal: false, window: FOLDED }, BUILD, NOW);

  it("keeps the newest PENDING_MAX", () => {
    let list: AppErrorReport[] = [];
    for (let i = 0; i < PENDING_MAX + 5; i++) list = queued(list, r(String(i)));
    expect(list).toHaveLength(PENDING_MAX);
    expect(list[0]?.message).toBe("Error: 5");
  });

  it("reads back as none when the file holds something else", () => {
    expect(parsePending(null)).toEqual([]);
    expect(parsePending({ message: "x" })).toEqual([]);
    expect(parsePending([r("a"), 3, null])).toHaveLength(1);
  });

  it("goes again only when the link, not the workspace, was the trouble", () => {
    expect(sendAgain({ code: "offline" })).toBe(true);
    expect(sendAgain({ code: "timeout" })).toBe(true);
    expect(sendAgain({ code: "disconnected" })).toBe(true);
    // A workspace from before app_error_report, or one that refused them.
    expect(sendAgain({ code: "unknown" })).toBe(false);
    expect(sendAgain({ code: "invalid" })).toBe(false);
  });
});

/** A keeper on a disk of its own, and every save it made. */
const kept = (start: AppErrorReport[] = []) => {
  let disk: unknown = start;
  const saves: number[] = [];
  const k = keeper({
    load: () => disk,
    save: (list) => {
      disk = [...list];
      saves.push(list.length);
    },
    build: () => BUILD,
    window: () => FOLDED,
    now: () => NOW,
  });
  return { k, disk: () => parsePending(disk), saves };
};

const flushed = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("The keeper", () => {
  it("keeps a fatal error on disk before anything else, and sends it at the next start", async () => {
    const before = kept();
    const sent: AppErrorReport[][] = [];
    const send: Send = (errors) => {
      sent.push([...errors]);
      return Promise.resolve(true);
    };
    before.k.sendTo(send);
    before.k.at("Chat");
    before.k.note(new Error("the end"), { fatal: true });
    expect(before.disk()).toHaveLength(1);
    expect(before.disk()[0]).toMatchObject({ fatal: true, screen: "Chat", message: "Error: the end" });
    await flushed();
    expect(sent).toHaveLength(0);
    // The next start: the same file, a new keeper, a workspace to send to.
    const after = kept(before.disk());
    after.k.sendTo(send);
    await flushed();
    expect(sent).toEqual([[expect.objectContaining({ fatal: true, message: "Error: the end" })]]);
    expect(after.disk()).toEqual([]);
  });

  it("sends one caught at once, the screen it names over the one on top", async () => {
    const { k, disk } = kept();
    const sent: AppErrorReport[] = [];
    k.sendTo((errors) => {
      sent.push(...errors);
      return Promise.resolve(true);
    });
    k.at("Home");
    k.note(new Error("a row"), { fatal: false, screen: "Chat" });
    await flushed();
    expect(sent.map((s) => s.screen)).toEqual(["Chat"]);
    expect(disk()).toEqual([]);
  });

  it("keeps what the link dropped for the next link, and what came in meanwhile", async () => {
    const { k, disk } = kept();
    let answer: (ok: boolean) => void = () => undefined;
    k.sendTo(() => new Promise<boolean>((resolve) => (answer = resolve)));
    k.note(new Error("first"), { fatal: false });
    k.note(new Error("second"), { fatal: false });
    answer(false);
    await flushed();
    expect(disk().map((r) => r.message)).toEqual(["Error: first", "Error: second"]);
    // Back: both go, and the one noted while they were on their way stays for the next send.
    let calls = 0;
    k.sendTo((errors) => {
      calls++;
      if (calls === 1) {
        expect(errors).toHaveLength(2);
        k.note(new Error("third"), { fatal: false });
      }
      return Promise.resolve(true);
    });
    await flushed();
    await flushed();
    expect(disk()).toEqual([]);
    expect(calls).toBe(2);
  });

  it("sends nothing without a workspace, and keeps it", async () => {
    const { k, disk } = kept();
    k.note(new Error("unpaired"), { fatal: false });
    await k.flush();
    expect(disk()).toHaveLength(1);
  });
});

describe("A fatal error", () => {
  const started = NOW - 60 * 60_000;

  it("starts the JavaScript over, as the person's 19:18 crash after 90 minutes would have", () => {
    expect(recovers(started, null, NOW)).toBe(true);
  });

  it("ends the app in its first seconds, where starting over would meet the same error at once", () => {
    expect(recovers(NOW - RECOVER_AFTER_MS + 1, null, NOW)).toBe(false);
  });

  it("ends the app when it started over a moment ago, so a fatal can't loop", () => {
    expect(recovers(started, NOW - 60_000, NOW)).toBe(false);
    expect(recovers(started, NOW - RECOVER_GAP_MS, NOW)).toBe(true);
    // A clock set back since: not a reason to end the app.
    expect(recovers(started, NOW + 60_000, NOW)).toBe(true);
  });
});
