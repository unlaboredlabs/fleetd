import {
  AskId,
  BatchId,
  DecisionId,
  DecisionKey,
  MachineId,
  ProjectId,
  WorkstreamId,
  type Ask,
  type Decision,
  type Workstream,
} from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { renderHumanDigest } from "./HumanDigest.ts";

const api = { machineId: MachineId.make("forge"), projectId: ProjectId.make("p-api") };
const web = { machineId: MachineId.make("mac"), projectId: ProjectId.make("p-web") };
const at = "2026-10-17T07:00:00.000Z";

const ask = (n: number, batch: number, extra: Partial<Ask>): Ask => ({
  askId: AskId.make(`A${n}`),
  projectRef: api,
  kind: "decide",
  key: DecisionKey.make(`k.${n}`),
  class: "product",
  text: `Question ${n}?`,
  recommendation: "yes",
  blocks: "nothing",
  proceededOnRec: false,
  state: "open",
  batchId: BatchId.make(`B${batch}`),
  number: n,
  createdAt: at,
  ...extra,
});

const twoChecks: Workstream["brief"] = {
  goal: "g",
  why: "w",
  pointers: [],
  constraints: [],
  doneWhen: [
    { type: "http", url: "http://lab/healthz", status: 200 },
    { type: "pr_merged", repo: "wynn-dev/lab" },
  ],
  tier: "S",
};

const workstream = (n: number, state: Workstream["state"], title: string, headline?: string, brief?: Workstream["brief"]): Workstream => ({
  workstreamId: WorkstreamId.make(`W${n}`),
  projectRef: n % 2 === 0 ? web : api,
  title,
  source: { text: title, channel: "app", by: "human", at },
  state,
  ...(headline === undefined ? {} : { headline }),
  ...(brief === undefined ? {} : { brief }),
  createdAt: at,
  updatedAt: at,
});

const decision = (n: number, k: string, value: string): Decision => ({
  decisionId: DecisionId.make(`D${n}`),
  key: DecisionKey.make(k),
  scope: { kind: "project", projectRef: api },
  value,
  source: "lead",
  state: "active",
  at,
});

describe("renderHumanDigest", () => {
  it("renders the DESIGN §4 shape: header, numbered asks, done, decided without you, running", () => {
    const text = renderHumanDigest({
      nowMs: Date.parse("2026-10-17T07:00:00.000Z"),
      tz: "Europe/Berlin",
      projectNames: new Map([
        ["forge/p-api", "api"],
        ["mac/p-web", "web"],
      ]),
      asks: [
        ask(2, 12, { class: "product", text: "Drop email sign-in?", recommendation: "keep", proceededOnRec: true, projectRef: web }),
        ask(1, 12, {
          class: "money",
          text: "Sentry plan for replay?",
          options: ["Team $26/mo", "Free"],
          recommendation: "Free",
        }),
        ask(3, 12, {
          kind: "do",
          class: "irreversible",
          text: "terraform apply prod",
          steps: [
            { text: "a", where: "browser" },
            { text: "b", where: "browser" },
          ],
          blocks: "deploy",
        }),
        ask(4, 11, { class: "credential", text: "Which GitHub org?", recommendation: "wynn-dev" }),
        ask(5, 12, { state: "answered" }),
      ],
      workstreams: [
        workstream(1, "running", "Add /health", "tests green", twoChecks),
        workstream(2, "done", "Billing webhook", undefined, twoChecks),
        workstream(3, "idle", "Old thing"),
        workstream(4, "failed", "Android sign-in", "CI red on main"),
      ],
      decidedWithoutYou: [
        decision(9, "pkg.manager", "pnpm"),
        decision(8, "http.retry", "3x on 429"),
        ...[7, 6, 5, 4].map((n) => decision(n, `k.d${n}`, `v${n}`)),
      ],
      facts: new Map([
        [WorkstreamId.make("W1"), { passed: new Set([0]), eta: "eta 1h (raw 30m × 2, 12 samples)" }],
        [WorkstreamId.make("W2"), { passed: new Set([0, 1]) }],
      ]),
    });
    expect(text.split("\n")).toEqual([
      "fleetd digest · Sat 17 Oct, 09:00",
      "B12 · 4 need you · 1 running · 1 done · 1 failed",
      "#B11 4 [credential] api: Which GitHub org? rec: wynn-dev",
      "1 [money] api: Sentry plan for replay? a) Team $26/mo b) Free rec: Free",
      "2 [product] web: Drop email sign-in? rec: keep (proceeded) — override?",
      '3 [do] api: terraform apply prod (2 steps; reply "3 done" when finished)   (blocks: deploy)',
      "Done: W2 web: Billing webhook · ✓ 2 of 2 checks",
      "Failed: W4 web: Android sign-in — lead says: CI red on main",
      'Decided without you (6): pkg.manager=pnpm (D9); http.retry=3x on 429 (D8); k.d7=v7 (D7); k.d6=v6 (D6); k.d5=v5 (D5) · reply "forget D9" to undo one',
      "Running: W1 api: Add /health — lead says: tests green · ✓ 1 of 2 checks · eta 1h (raw 30m × 2, 12 samples)",
    ]);
  });

  it("says nothing needs you, and falls back to UTC for an unknown zone", () => {
    const text = renderHumanDigest({
      nowMs: Date.parse("2026-10-17T18:00:00.000Z"),
      tz: "Mars/Olympus",
      projectNames: new Map(),
      asks: [],
      workstreams: [],
      decidedWithoutYou: [],
    });
    expect(text).toBe("fleetd digest · Sat 17 Oct, 18:00 UTC\nNothing needs you · 0 running · 0 done");
  });
});
