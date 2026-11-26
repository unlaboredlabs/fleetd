// The phone's over-the-air updates in stages (.github/release/phone-rollout.ts): what each stage serves as an update
// ages, is halted or pulled, per runtime version, and the channel's directory written from the updates' packages.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_UPDATES, phoneMoving, prunePhone, served, servedText, updateOf, writeServed, type PhoneUpdate } from "../../.github/release/phone-rollout.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-27T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

/** An update published `ago` before T0, for runtime version `runtime` on both platforms. */
const u = (id: string, ago: number, runtime = "f1", more: Partial<PhoneUpdate> = {}): PhoneUpdate => ({
  id,
  platforms: { ios: { id, runtime }, android: { id: `${id}-a`, runtime: `${runtime}-a` } },
  commit: "c".repeat(40),
  publishedAt: at(-ago),
  ...more,
});

/** What each stage serves iOS for runtime `runtime`: everyone's, stage50's, stage10's. */
function ios(updates: PhoneUpdate[], runtime = "f1") {
  const s = served({ updates }, T0).filter((x) => x.platform === "ios" && x.runtime === runtime);
  const of = (dir: string) => {
    const x = s.find((x) => x.dir === dir);
    return x === undefined ? undefined : `${x.from}${x.back ? " back" : ""}`;
  };
  return { everyone: of(""), stage50: of("stage50"), stage10: of("stage10") };
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

test("an update reaches about 10% of installs at once, 50% after an hour and everyone after 3 hours", () => {
  const old = u("old", 10 * HOUR);
  expect(ios([u("new", 0), old])).toEqual({ everyone: "old", stage50: "old", stage10: "new" });
  expect(ios([u("new", HOUR), old])).toEqual({ everyone: "old", stage50: "new", stage10: "new" });
  expect(ios([u("new", 3 * HOUR), old])).toEqual({ everyone: "new", stage50: "new", stage10: "new" });
  // With nothing before it, the later stages serve nothing yet: those phones keep the bundle they run.
  expect(ios([u("first", 0)])).toEqual({ everyone: undefined, stage50: undefined, stage10: "first" });
  expect(phoneMoving({ updates: [u("new", HOUR), old] }, T0)).toBe(true);
  expect(phoneMoving({ updates: [u("new", 3 * HOUR), old] }, T0)).toBe(false);
});

test("a halted update reaches nobody new: each stage serves the newest one before it that reached it", () => {
  const halted = u("bad", 2 * HOUR, "f1", { haltedAt: at(0) });
  expect(ios([halted, u("good", 10 * HOUR)])).toEqual({ everyone: "good", stage50: "good", stage10: "good" });
  // One published after it moves on as usual.
  expect(ios([u("next", 0), halted, u("good", 10 * HOUR)])).toEqual({ everyone: "good", stage50: "good", stage10: "next" });
  expect(phoneMoving({ updates: [halted, u("good", 10 * HOUR)] }, T0)).toBe(false);
});

test("only the newest update advances: a revert stops a bad update from going on to 50% and everyone", () => {
  // Good U0 is everyone's; bad U1 went to the first stage 30 minutes before its revert U2 was published.
  const updates = [u("revert", 0), u("bad", 30 * 60_000), u("good", 10 * HOUR)];
  const later = (ms: number) => {
    const s = served({ updates }, T0 + ms).filter((x) => x.platform === "ios");
    return Object.fromEntries(s.map((x) => [x.dir || "everyone", x.from]));
  };
  // At T0 + 2h45m, the bad one would be 3h15m out and everyone's without the rule; it stays at its first stage, which
  // the revert has taken over, so it reaches nobody more.
  expect(later(2 * HOUR + 45 * 60_000)).toEqual({ stage10: "revert", stage50: "revert", everyone: "good" });
  expect(later(3 * HOUR)).toEqual({ stage10: "revert", stage50: "revert", everyone: "revert" });
  // The ticker stops once the newest is everyone's: the stopped one doesn't keep it going.
  expect(phoneMoving({ updates }, T0 + 2 * HOUR)).toBe(true);
  expect(phoneMoving({ updates }, T0 + 3 * HOUR)).toBe(false);
});

test("a pulled update takes back everyone who has it: every stage serves its back copy until a newer one", () => {
  const pulled = u("bad", 2 * HOUR, "f1", { pulledAt: at(0) });
  expect(ios([pulled, u("good", 10 * HOUR)])).toEqual({ everyone: "bad back", stage50: "bad back", stage10: "bad back" });
  // The next update goes out over it, stage by stage, the back copy serving the stages it hasn't reached.
  expect(ios([u("fix", 0), pulled, u("good", 10 * HOUR)])).toEqual({ everyone: "bad back", stage50: "bad back", stage10: "fix" });
});

test("each runtime version has its own stages: an update never reaches a build of another fingerprint", () => {
  const updates = [u("f2-new", 0, "f2"), u("f1-old", 10 * HOUR, "f1")];
  expect(ios(updates, "f1")).toEqual({ everyone: "f1-old", stage50: "f1-old", stage10: "f1-old" });
  expect(ios(updates, "f2")).toEqual({ everyone: undefined, stage50: undefined, stage10: "f2-new" });
  // Android's go by Android's runtime version.
  const android = served({ updates }, T0).filter((x) => x.platform === "android");
  expect(new Set(android.map((x) => x.runtime))).toEqual(new Set(["f1-a", "f2-a"]));
});

test("only the newest updates stay listed, and any older one a stage still serves", () => {
  // A busy day: more updates than are kept, all published within the hour, so everyone still has the oldest.
  const updates = Array.from({ length: MAX_UPDATES + 3 }, (_, i) => u(`u${i}`, i === MAX_UPDATES + 2 ? 10 * HOUR : i * 60_000));
  const { kept, dropped } = prunePhone({ updates }, T0);
  expect(kept.map((x) => x.id)).toEqual([...updates.slice(0, MAX_UPDATES).map((x) => x.id), `u${MAX_UPDATES + 2}`]);
  expect(dropped).toEqual([`u${MAX_UPDATES}`, `u${MAX_UPDATES + 1}`]);
});

test("a package's updates.txt names the update, by its iOS id", () => {
  const txt = "ios f1 11111111-2222-3333-4444-555555555555\nandroid f1-a 66666666-7777-8888-9999-000000000000\ncert abc\n";
  expect(updateOf(txt, "c".repeat(40), at(0))).toEqual({
    id: "11111111-2222-3333-4444-555555555555",
    platforms: { ios: { id: "11111111-2222-3333-4444-555555555555", runtime: "f1" }, android: { id: "66666666-7777-8888-9999-000000000000", runtime: "f1-a" } },
    commit: "c".repeat(40),
    publishedAt: at(0),
  });
  expect(() => updateOf("cert abc\n", "c".repeat(40), at(0))).toThrow("lists no update");
});

test("the channel's directory holds each stage's manifest, the back copies a pull serves and every file they name", () => {
  const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "phone-rollout-"));
  dirs.push(work);
  // Two packages as updates.ts writes them (with --served).
  for (const id of ["good", "bad"]) {
    for (const [path, text] of <[string, string][]>[
      [`f1/ios`, `${id} manifest`],
      [`back/f1/ios`, `${id} back`],
      [`f1-a/android`, `${id} android`],
      [`back/f1-a/android`, `${id} android back`],
      [`assets/${id}.bundle`, `${id} bytes`],
    ]) {
      mkdirSync(join(work, "pkg", id, path, ".."), { recursive: true });
      writeFileSync(join(work, "pkg", id, path), text);
    }
  }
  const updates = [u("bad", 2 * HOUR, "f1", { pulledAt: at(0) }), u("good", 10 * HOUR)];
  const s = served({ updates }, T0);
  const out = join(work, "out");
  writeServed(s, (id) => join(work, "pkg", id), out);
  const read = (p: string) => readFileSync(join(out, p), "utf8");
  for (const dir of ["", "stage50/", "stage10/"]) {
    expect(read(`${dir}f1/ios`)).toBe("bad back");
    expect(read(`${dir}f1-a/android`)).toBe("bad android back");
  }
  expect(read("assets/bad.bundle")).toBe("bad bytes");
  expect(read("served.txt")).toBe(servedText(s));
  expect(read("served.txt")).toContain("everyone ios f1 bad back\n");
});
