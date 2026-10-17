import type { Workstream, WorkstreamId } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { DIGEST_MAX_TOKENS, estimateTokens, renderLeadDigest, type DigestInput } from "./digest.ts";
import { ask, decision, REF } from "./testKit.ts";

const workstream = (n: number, over: Partial<Workstream> = {}): Workstream =>
  ({
    workstreamId: `W${n}` as WorkstreamId,
    projectRef: REF,
    title: `workstream ${n}`,
    source: { text: `workstream ${n}`, channel: "app", by: "human", at: "2026-10-17T10:00:00.000Z" },
    state: "draft",
    createdAt: "2026-10-17T10:00:00.000Z",
    updatedAt: "2026-10-17T10:00:00.000Z",
    ...over,
  }) as Workstream;

const input = (over: Partial<DigestInput> = {}): DigestInput => ({
  project: { ref: REF, title: "Demo" },
  at: "2026-10-17T12:00:00.000Z",
  workstreams: [],
  openAsks: [],
  answers: [],
  decisions: [],
  ...over,
});

describe("renderLeadDigest", () => {
  it("lists workstreams with state, done-when and headline, asks, answers, decisions and do-not-re-ask keys", () => {
    const d1 = decision(1, "api.health.path", "/healthz");
    const text = renderLeadDigest(
      input({
        workstreams: [
          workstream(2, {
            title: "add a /health endpoint",
            state: "running",
            headline: "endpoint written, PR open",
            brief: {
              goal: "health endpoint",
              why: "probes",
              pointers: [],
              constraints: [],
              doneWhen: [
                { type: "http", url: "http://lab:4710/healthz", status: 200 },
                { type: "pr_merged", repo: "wynn-dev/lab" },
              ],
              tier: "S",
            },
          }),
          workstream(3),
        ],
        openAsks: [ask(4, "db.engine", { batchId: "B1" as never, number: 2, recommendation: "sqlite", proceededOnRec: true })],
        answers: [{ ask: ask(1, "api.health.path", { state: "answered" }), decision: d1 }],
        decisions: [d1],
      }),
    );
    expect(text).toBe(
      [
        "# fleetd digest: project Demo (lab-a/p1), 2026-10-17T12:00:00.000Z",
        "This is the current truth about your project. Trust it over your memory.",
        "",
        "## Answers since your last wake",
        "- A1 api.health.path → /healthz (D1)",
        "",
        "## Open workstreams",
        "- W2 running: add a /health endpoint",
        "  status: endpoint written, PR open",
        "  done when: 1) GET http://lab:4710/healthz → 200; 2) PR merged in wynn-dev/lab",
        "- W3 draft: workstream 3",
        "  no brief yet: register it with `fleetd brief create --workstream W3 --json '<Brief>'`",
        "",
        "## Your open asks",
        "- A4 (#2 in B1) [product] db.engine: Question 4?; rec sqlite; you proceeded on the rec",
        "",
        "## Decisions (most relevant)",
        "- D1 api.health.path = /healthz (project, human)",
        "",
        "## Do not re-ask: keys already decided or asked",
        "api.health.path, db.engine",
      ].join("\n"),
    );
  });

  it("lists the 10 most relevant decisions: open workstreams', then the project's, then global, newest first", () => {
    const open = workstream(1, { state: "running" });
    const decisions = [
      ...Array.from({ length: 6 }, (_, i) => decision(10 + i, `global.k${i}`, "g", { scope: { kind: "global" } })),
      ...Array.from({ length: 6 }, (_, i) => decision(20 + i, `project.k${i}`, "p")),
      decision(30, "ws.k", "w", { scope: { kind: "workstream", workstreamId: "W1" as WorkstreamId } }),
      decision(31, "closed.k", "c", { scope: { kind: "workstream", workstreamId: "W9" as WorkstreamId } }),
    ];
    const text = renderLeadDigest(input({ workstreams: [open], decisions }));
    const listed = [...text.matchAll(/^- (D\d+) /gmu)].map((m) => m[1]);
    expect(listed).toEqual(["D30", "D25", "D24", "D23", "D22", "D21", "D20", "D15", "D14", "D13"]);
    expect(text).toContain("(+4 more: `fleetd decisions search \"<q>\"`)");
    // Keys beyond the top 10 still count as decided.
    expect(text).toContain("global.k0");
    expect(text).toContain("closed.k");
  });

  it("stays within the token budget on a huge project, keeping every answer and some of each section", () => {
    const long = "x".repeat(1900);
    const text = renderLeadDigest(
      input({
        workstreams: Array.from({ length: 40 }, (_, i) => workstream(i + 1, { title: long, headline: long, state: "running" })),
        openAsks: Array.from({ length: 40 }, (_, i) => ask(100 + i, `ask.key${i}`, { text: long })),
        answers: Array.from({ length: 5 }, (_, i) => ({ ask: ask(i + 1, `answered.k${i}`), decision: decision(i + 1, `answered.k${i}`, "fine") })),
        decisions: Array.from({ length: 300 }, (_, i) => decision(200 + i, `decided.key.number${i}`, long)),
      }),
    );
    expect(estimateTokens(text)).toBeLessThanOrEqual(DIGEST_MAX_TOKENS);
    expect([...text.matchAll(/^- A\d+ answered\.k/gmu)]).toHaveLength(5);
    expect(text).toContain("## Open workstreams\n- W1 running");
    expect(text).toContain("## Your open asks\n- A100 ");
    expect(text).toMatch(/## Decisions \(most relevant\)\n- D\d+ /u);
    expect(text).toMatch(/## Do not re-ask: keys already decided or asked\n[a-z].*\(\+\d+ more: check with `fleetd decisions search`\)/u);
  });

  it("says none for empty sections", () => {
    const text = renderLeadDigest(input());
    expect(text).toContain("## Open workstreams\nnone");
    expect(text).toContain("## Do not re-ask: keys already decided or asked\nnone");
  });
});
