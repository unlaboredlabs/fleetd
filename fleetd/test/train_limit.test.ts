// GitHub's API rate limit (W631): on 2026-11-12 the hub's App installation used its hourly budget up, and the train
// refused fresh PRs with "Check the URL" on GitHub's 403 "API rate limit exceeded for installation ID …". A used-up
// limit is waited out until the reset GitHub names: nothing is refused, failed or dropped for it, and the wait shows on
// the Change's state line. GETs ask again with their ETag, so an unchanged answer (304) costs no call; under a tenth
// of the budget left, the hub warns once and polls less often until the reset.
import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { Budget, LIMIT_WAIT_MAX_MS, limitNote, SPREAD, WAITING_FOR_LIMIT } from "../src/hub/train/budget.ts";
import type { GhOut, GhRunner } from "../src/hub/train/gh.ts";
import { TrainGitHub } from "../src/hub/train/github.ts";
import { hubReads, pollCiWaits } from "../src/hub/tasks/ci_wait.ts";
import { leadCall } from "../src/hub/tasks/calls.ts";
import { type FakeGh, Kit, REPO } from "./train_kit.ts";
import { P, tasksKit } from "./tasks-kit.ts";

setDefaultTimeout(30_000);
let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});

const MINUTE = 60_000;
const LIMITED = "API rate limit exceeded for installation ID 176109973. If you reach out to GitHub Support for help, please include the request ID EDCA:239380:A2E4DE9:F514A0E:6AF575BC";

/**
 * GitHub as the hub's `gh api -i` sees it, around the fake: each answer with its status line, an ETag and the budget's
 * `x-ratelimit-*`; a GET carrying the ETag of an unchanged answer gets a 304, which GitHub doesn't count. Once `trip`
 * matches a call, every call is refused with the primary limit's 403 for `limitMs`, until its reset.
 */
class StandIn implements GhRunner {
  /** The calls GitHub counted against the budget, each its method and path. */
  readonly billed: string[] = [];
  /** The 304s, each its path: asked again, unchanged, not counted. */
  readonly free: string[] = [];
  /** The calls refused for the limit. */
  refused = 0;
  limit = 5000;
  remaining = 5000;
  resetMs: number;
  limitedUntil?: number;
  trip?: (args: string[]) => boolean;
  limitMs = 5 * MINUTE;

  constructor(
    readonly base: GhRunner,
    readonly now: () => number,
  ) {
    this.resetMs = now() + 60 * MINUTE;
  }

  private head(status: number, text: string, etag?: string): string {
    const lines = [
      `HTTP/2.0 ${status} ${status === 200 ? "OK" : status === 304 ? "Not Modified" : "Forbidden"}`,
      ...(etag !== undefined ? [`Etag: ${etag}`] : []),
      `X-Ratelimit-Limit: ${this.limit}`,
      `X-Ratelimit-Remaining: ${this.remaining}`,
      `X-Ratelimit-Reset: ${Math.floor((this.limitedUntil ?? this.resetMs) / 1000)}`,
      "X-Ratelimit-Resource: core",
    ];
    return `${lines.join("\r\n")}\r\n\r\n${text}`;
  }

  async run(args: string[]): Promise<GhOut> {
    const now = this.now();
    if (this.trip?.(args)) {
      this.trip = undefined;
      this.limitedUntil = now + this.limitMs;
    }
    if (this.limitedUntil !== undefined && now < this.limitedUntil) {
      this.refused++;
      if (args[0] !== "api") return { exitCode: 1, stdout: "", stderr: `GraphQL: ${LIMITED}\n` };
      this.remaining = 0;
      return { exitCode: 1, stdout: this.head(403, JSON.stringify({ message: LIMITED })), stderr: `gh: ${LIMITED} (HTTP 403)\n` };
    }
    if (this.limitedUntil !== undefined) {
      this.limitedUntil = undefined;
      this.remaining = this.limit;
    }
    const out = await this.base.run(args);
    const method = args[args.indexOf("-X") + 1] ?? "GET";
    const path = args.find((a) => a.startsWith("repos/") || a === "graphql") ?? args.slice(0, 2).join(" ");
    if (args[0] !== "api") {
      this.billed.push(`${args[0]} ${args[1]}`);
      return out;
    }
    const etag = `"${Bun.hash(out.stdout).toString(16)}"`;
    const asked = args.find((a) => a.startsWith("If-None-Match: "))?.slice("If-None-Match: ".length);
    if (out.exitCode === 0 && method === "GET" && asked === etag) {
      this.free.push(`${method} ${path.split("?")[0]}`);
      return { exitCode: 1, stdout: this.head(304, "", etag), stderr: "gh: HTTP 304\n" };
    }
    this.billed.push(`${method} ${path.split("?")[0]}`);
    this.remaining = Math.max(this.remaining - 1, 0);
    const status = out.exitCode === 0 ? 200 : Number(/HTTP (\d{3})/.exec(out.stderr)?.[1] ?? 500);
    return { ...out, stdout: this.head(status, out.stdout, out.exitCode === 0 ? etag : undefined) };
  }
}

function limitKit(): { k: Kit; gh: StandIn; lines: string[] } {
  const lines: string[] = [];
  let k: Kit | undefined;
  let gh: StandIn | undefined;
  k = new Kit(
    {
      // Each wait moves the clock; a long one (the limit's) notes the state lines it waited with.
      sleep: async (ms) => {
        if (ms >= MINUTE) for (const c of k!.train.records.list({ limit: 50 })) if (c.lastError !== undefined) lines.push(c.lastError);
        k!.clock.ms += ms;
        await Bun.sleep(0);
      },
    },
    (fake: FakeGh, now) => (gh = new StandIn(fake, now)),
  );
  kits.push(k);
  return { k, gh: gh!, lines };
}

// --- done:0, a PR enqueued while the limit is used up is kept, read once it resets, and goes to review ---

test("a PR enqueued with change_enqueue while GitHub's rate limit is used up is kept, then read and reviewed after the reset", async () => {
  const { k, gh } = limitKit();
  k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing\n" });
  gh.trip = () => true;
  const asked = k.enqueue(7);
  await expect(asked).rejects.toMatchObject({ code: "unavailable" });
  const e = await asked.catch((x) => x);
  expect(e.message).toContain("GitHub's API rate limit is used up until 2026-10-17T10:05:00Z");
  expect(e.message).toContain("Nothing is wrong with the PR");
  expect(e.fix).toContain("the train reads it once the limit resets");
  expect(k.train.records.latestFor(REPO, 7)).toBeUndefined();
  // Before the reset nothing is asked of GitHub: a pass spends no call.
  const refused = gh.refused;
  k.clock.ms += MINUTE;
  await k.train.step(REPO);
  expect(gh.refused).toBe(refused);
  // After it, the train's next pass reads it, with no one enqueuing it again, and it goes to review and merges.
  k.clock.ms += 5 * MINUTE;
  await k.train.step(REPO);
  expect(k.gate.reviewed).toContain(k.change(7).changeId);
  await k.settle();
  expect(k.change(7).state).toBe("merged");
  expect(k.host.wakes.some((w) => w.includes("refused"))).toBe(false);
});

test("a task's PR result read while GitHub's rate limit is used up is not refused, and is reviewed after the reset", async () => {
  const { k, gh } = limitKit();
  k.pr(8, "fleetd/T8-cart", { "cart.md": "cart\n" });
  gh.trip = () => true;
  await k.train.onTaskPr("T8");
  expect(k.host.wakes).toEqual([]);
  expect(k.train.records.latestFor(REPO, 8)).toBeUndefined();
  k.clock.ms += 6 * MINUTE;
  await k.train.step(REPO);
  const change = k.change(8);
  expect(change.taskId).toBe("T8");
  expect(k.gate.reviewed).toContain(change.changeId);
  await k.settle();
  expect(k.change(8).state).toBe("merged");
  expect(k.host.wakes.some((w) => w.includes("refused"))).toBe(false);
});

// --- done:1, the train's reads and writes during a pass, and wait_ci's watch ---

test("checks read in CI while the limit is used up are waited out to the reset, said on the state line, and the PR merges", async () => {
  const { k, gh, lines } = limitKit();
  k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing\n" });
  await k.enqueue(7);
  // The limit runs out once the PR is in CI, at its first read of the checks.
  gh.trip = (args) => k.change(7).state === "ci" && args.some((a) => a.includes("/check-runs"));
  gh.limitMs = 50 * MINUTE;
  await k.settle();
  expect(gh.refused).toBe(1);
  expect(lines.some((l) => l.startsWith(`${WAITING_FOR_LIMIT} at `) && l.includes("the train goes on then"))).toBe(true);
  // 50 minutes of a used-up limit are none of CI's 45: it merges, and its state line no longer says it waits.
  const merged = k.change(7);
  expect(merged.state).toBe("merged");
  expect(merged.lastError ?? "").not.toContain(WAITING_FOR_LIMIT);
});

test("a merge GitHub refuses for the limit puts the PR back in line, not failed, and it merges after the reset", async () => {
  const { k, gh } = limitKit();
  k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing\n" });
  await k.enqueue(7);
  gh.trip = (args) => args.some((a) => a.endsWith("/pulls/7/merge"));
  for (let i = 0; i < 3 && k.change(7).state !== "ready"; i++) await k.train.step(REPO);
  for (let i = 0; i < 3 && gh.limitedUntil === undefined; i++) await k.train.step(REPO);
  const back = k.change(7);
  expect(back.state).toBe("ready");
  expect(back.lastError).toBe(limitNote(k.train.github.limitedUntil(REPO)!));
  expect(k.host.sends).toEqual([]);
  // A pass before the reset takes nothing; the one after it merges.
  k.clock.ms = gh.limitedUntil!;
  await k.settle();
  expect(k.change(7).state).toBe("merged");
  expect(k.gh.log.filter((l) => l.startsWith("merge "))).toEqual(["merge #7"]);
});

test("a branch update GitHub refuses for the limit puts the PR back in line, and it merges after the reset", async () => {
  const { k, gh } = limitKit();
  k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing\n" });
  // Main moves on: the PR's branch is brought up to date before its CI.
  k.commitMain({ "other.md": "other\n" });
  await k.enqueue(7);
  gh.trip = (args) => args[0] === "pr" && args[1] === "update-branch";
  for (let i = 0; i < 4 && gh.limitedUntil === undefined; i++) await k.train.step(REPO);
  expect(gh.refused).toBe(1);
  expect(k.change(7).state).toBe("ready");
  expect(k.change(7).lastError).toStartWith(WAITING_FOR_LIMIT);
  k.clock.ms = gh.limitedUntil!;
  await k.settle();
  expect(k.change(7).state).toBe("merged");
  expect(k.host.sends).toEqual([]);
});

test("wait_ci's watch waits a used-up limit out instead of counting it as failed reads, then wakes its task", async () => {
  const k = tasksKit();
  void k.t.run();
  await k.spawn("CI", "read");
  k.hub.db.conn
    .query("INSERT INTO repos (machine_id, project_id, checkout_machine_id, checkout_project_id, name, repo_key) VALUES ('lab-a', 'p1', 'lab-a', 'p1', 'shop', 'github.com/acme/shop')")
    .run();
  const task = { projectRef: P, by: "lead:lab-a/p1", agent: { kind: "task" as const, taskId: "T1" } };
  await leadCall(k.hub, k.t, task, { op: "wait_ci", url: "https://github.com/acme/shop/actions/runs/42" });
  const run: GhRunner = {
    run: async (args) => {
      const path = args.find((a) => a.startsWith("repos/")) ?? "";
      const body = path.endsWith("/jobs?filter=latest&per_page=100")
        ? { jobs: [{ name: "build", conclusion: "success" }] }
        : { id: 42, status: "completed", conclusion: "success", name: "ci" };
      return { exitCode: 0, stdout: JSON.stringify(body), stderr: "" };
    },
  };
  const gh = new StandIn(run, () => k.clock.ms);
  gh.trip = () => true;
  const github = new TrainGitHub(gh, { expect() {}, forget() {}, touch() {}, fail() {} }, () => k.clock.ms, async () => {});
  const reads = hubReads(k.hub, github);
  // Five polls while the limit is used up: the first is refused, the rest ask GitHub nothing, and the wait goes on.
  for (let i = 0; i < 5; i++) {
    expect(await pollCiWaits(k.t, k.hub.db.conn, k.clock.ms, reads)).toBe(0);
    k.clock.ms += 30_000;
  }
  expect(gh.refused).toBe(1);
  expect(k.ports.sends).toEqual([]);
  k.clock.ms += 5 * MINUTE;
  expect(await pollCiWaits(k.t, k.hub.db.conn, k.clock.ms, reads)).toBe(1);
  expect(k.ports.sends.at(-1)?.message).toContain("finished: https://github.com/acme/shop/actions/runs/42 (ci) succeeded");
  k.hub.shutdown.abort();
});

// --- done:2, the heaviest spender: every pass read each waiting Change's PR, now asked again with its ETag ---

test("a Change waiting in review is read every pass, but GitHub counts its PR read once while nothing changes", async () => {
  const { k, gh } = limitKit();
  k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing\n" });
  // Its review blocks it: it waits, and each pass reads its PR for a push.
  k.gate.blocking.add("X1");
  await k.enqueue(7);
  expect(k.change(7).state).toBe("reviewing");
  const read = `GET repos/${REPO}/pulls/7`;
  const counted = () => gh.billed.filter((c) => c === read).length;
  const unchanged = () => gh.free.filter((c) => c === read).length;
  const [before, free] = [counted(), unchanged()];
  for (let i = 0; i < 20; i++) {
    k.clock.ms += 15_000;
    await k.train.step(REPO);
  }
  // 20 passes read it 20 times, each a 304 GitHub doesn't count, where before the cut each was a counted call.
  expect(unchanged() - free).toBe(20);
  expect(counted() - before).toBe(0);
  expect(k.change(7).state).toBe("reviewing");
  // A push changes the answer: read in full once, and its new head goes to review.
  k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing, again\n" });
  k.clock.ms += 15_000;
  await k.train.step(REPO);
  expect(counted() - before).toBe(1);
  expect(k.change(7).headSha).toBe(k.gh.headOf("fleetd/T7-pricing")!);
});

// --- done:3, under a tenth of the budget: one warning with the reset time, and polls spread out until then ---

test("under a tenth of the budget left, the hub warns once with the reset time and polls less often until the reset", async () => {
  let now = Date.parse("2026-11-12T08:00:00Z");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const budget = new Budget(() => now);
    const reset = String(Date.parse("2026-11-12T08:17:00Z") / 1000);
    const at = (remaining: number) => new Map([["x-ratelimit-limit", "5000"], ["x-ratelimit-remaining", String(remaining)], ["x-ratelimit-reset", reset]]);
    budget.seen("unlaboredlabs", "core", at(600));
    expect(budget.spread(15_000)).toBe(15_000);
    expect(warn).not.toHaveBeenCalled();
    budget.seen("unlaboredlabs", "core", at(499));
    budget.seen("unlaboredlabs", "core", at(450));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toBe(
      `github: 499 of unlaboredlabs's 5000 core API calls are left until 2026-11-12T08:17:00Z; the hub polls GitHub ${SPREAD} times less often until then`,
    );
    expect(budget.spread(15_000)).toBe(15_000 * SPREAD);
    expect(budget.spread(15_000, "unlaboredlabs")).toBe(15_000 * SPREAD);
    expect(budget.spread(15_000, "acme")).toBe(15_000);
    // Used up: no call until its reset, which is capped.
    expect(budget.usedUp("unlaboredlabs", "core", at(0))).toBe(Date.parse("2026-11-12T08:17:00Z"));
    expect(budget.until("unlaboredlabs")).toBe(Date.parse("2026-11-12T08:17:00Z"));
    expect(budget.usedUp("acme", "core", new Map([["x-ratelimit-remaining", "0"], ["x-ratelimit-reset", String(now / 1000 + 7200)]]))).toBe(now + LIMIT_WAIT_MAX_MS);
    // A secondary limit with budget left: GitHub's minute, not the hour's reset.
    const left = new Map([["x-ratelimit-remaining", "4200"], ["x-ratelimit-reset", String(now / 1000 + 3000)]]);
    expect(budget.usedUp("second", "core", left)).toBe(now + MINUTE);
    expect(budget.usedUp("other", "core", new Map([["retry-after", "30"]]))).toBe(now + 30_000);
    now = Date.parse("2026-11-12T08:17:01Z");
    expect(budget.until("unlaboredlabs")).toBeUndefined();
    expect(budget.spread(15_000, "unlaboredlabs")).toBe(15_000);
  } finally {
    warn.mockRestore();
  }
});

test("the train's loop polls less often while the budget is low, and sleeps to the reset while it is used up", async () => {
  const sleeps: number[] = [];
  let gh: StandIn | undefined;
  let stopped!: () => void;
  const over = new Promise<void>((resolve) => (stopped = resolve));
  const k: Kit = new Kit(
    {
      autoRun: true,
      sleep: async (ms) => {
        sleeps.push(ms);
        k.clock.ms += ms;
        // Two passes at the low budget's pace, then the limit runs out.
        if (sleeps.length === 2) gh!.trip = () => true;
        if (sleeps.length === 3) {
          k.train.stop();
          stopped();
        }
        await Bun.sleep(0);
      },
    },
    (fake, now) => (gh = new StandIn(fake, now)),
  );
  kits.push(k);
  gh!.remaining = 100;
  k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing\n" });
  // Its review blocks it: each pass of the loop only reads it.
  k.gate.blocking.add("X1");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await k.enqueue(7);
    await over;
  } finally {
    warn.mockRestore();
  }
  // The kit's poll interval is 1 s: 4 s while under a tenth, then the 5 minutes to the reset in one wait.
  expect(sleeps.slice(0, 2)).toEqual([1000 * SPREAD, 1000 * SPREAD]);
  expect(sleeps[2]).toBeGreaterThan(4 * MINUTE);
  expect(sleeps[2]).toBeLessThanOrEqual(5 * MINUTE);
  expect(gh!.refused).toBe(1);
});

test("the train's loop sleeps out a branch update's limit (GitHub's GraphQL budget) instead of running passes back to back", async () => {
  // Each wait: how long, and how many calls GitHub had refused by then.
  const sleeps: [number, number][] = [];
  let gh: StandIn | undefined;
  let stopped!: () => void;
  const over = new Promise<void>((resolve) => (stopped = resolve));
  const k: Kit = new Kit(
    {
      autoRun: true,
      sleep: async (ms) => {
        sleeps.push([ms, gh!.refused]);
        k.clock.ms += ms;
        if (k.train.records.latestFor(REPO, 7)?.state === "merged" || sleeps.length >= 200) {
          k.train.stop();
          stopped();
        }
        await Bun.sleep(0);
      },
    },
    (fake, now) => (gh = new StandIn(fake, now)),
  );
  kits.push(k);
  k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing\n" });
  // Main moves on: the PR's branch is brought up to date before its CI, and GitHub refuses that for the limit.
  k.commitMain({ "other.md": "other\n" });
  gh!.trip = (args) => args[0] === "pr" && args[1] === "update-branch";
  gh!.limitMs = MINUTE;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await k.enqueue(7);
    await over;
  } finally {
    warn.mockRestore();
  }
  expect(gh!.refused).toBe(1);
  // The first wait after the refusal runs to the reset, a minute away, and the PR merges after it.
  const after = sleeps.find(([, refused]) => refused === 1);
  expect(after?.[0]).toBeGreaterThanOrEqual(MINUTE - 1000);
  expect(k.change(7).state).toBe("merged");
  expect(sleeps.length).toBeLessThan(200);
});
