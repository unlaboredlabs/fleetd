import { describe, expect, it } from "vitest";
import type { Task } from "./contracts";
import { changeStat, changeTotals, endedWord, fileParts, ranFor, siteOf, turnAgentLine, turnList, turnStamp, urlsIn } from "./finished";

const task = (patch: Partial<Task>): Task =>
  ({
    attempt: 1,
    createdAt: "2026-11-26T18:00:00.000Z",
    kind: "write",
    projectRef: { machineId: "devbox", projectId: "shop" },
    prompt: "p",
    state: "done",
    taskId: "T1",
    title: "Add the page",
    workstreamId: "W1",
    ...patch,
  });

describe("a finished agent in words", () => {
  it("says how it ended and how long it ran", () => {
    expect([endedWord("done"), endedWord("failed"), endedWord("cancelled"), endedWord("running")]).toEqual(["Finished", "Failed", "Stopped", undefined]);
    expect(ranFor(task({ startedAt: "2026-11-26T18:00:10.000Z", endedAt: "2026-11-26T18:12:50.000Z" }))).toBe("12m 40s");
    // No start: from when it was made. No end: nothing to say.
    expect(ranFor(task({ endedAt: "2026-11-26T18:00:27.000Z" }))).toBe("27s");
    expect(ranFor(task({}))).toBeUndefined();
    expect(turnAgentLine(task({ state: "failed", endedAt: "2026-11-26T18:01:00.000Z" }))).toBe("Failed · 1m 0s");
    expect(turnAgentLine(task({ state: "running" }))).toBe("Working");
  });

  it("names a file by its name, its folder after, and its lines", () => {
    expect(fileParts("app/src/screens/Chat.tsx")).toEqual({ name: "Chat.tsx", dir: "app/src/screens" });
    expect(fileParts("README.md")).toEqual({ name: "README.md", dir: "" });
    expect([changeStat(12, 3), changeStat(4, 0), changeStat(0, 2), changeStat(0, 0)]).toEqual(["+12 −3", "+4", "−2", ""]);
    expect(changeTotals([{ additions: 1, deletions: 2 }, { additions: 3, deletions: 0 }])).toEqual({ additions: 4, deletions: 2 });
  });
});

describe("a finished turn's stamp", () => {
  it("says the order's whole time and its agents on the reply that closes it, not the last turn's seconds", () => {
    // The report's bug: a three-minute, three-agent order read "Worked for 27s".
    expect(turnStamp({ ms: 27_000, order: { ms: 190_000, agents: 3 } })).toBe("Done in 3m 10s · 3 agents");
    expect(turnStamp({ ms: 27_000, order: { ms: 65_000, agents: 1 } })).toBe("Done in 1m 5s · 1 agent");
    expect(turnStamp({ ms: 27_000, order: { ms: 40_000, agents: 0 } })).toBe("Done in 40s");
    expect(turnStamp({ ms: 27_000 })).toBe("Worked for 27s");
  });

  it("lists a turn's agents oldest first, their files added up by path, and each link once", () => {
    const a = task({ taskId: "T2", title: "Second", createdAt: "2026-11-26T18:01:00.000Z", result: { at: "", status: "done", tail: "", files: [{ path: "a.ts", additions: 1, deletions: 0 }] } });
    const b = task({ taskId: "T1", title: "First", result: { at: "", status: "done", tail: "", files: [{ path: "a.ts", additions: 2, deletions: 1 }, { path: "b.ts", additions: 0, deletions: 4 }] } });
    const list = turnList([a, b], [
      { url: "https://en.wikipedia.org/wiki/Stock", label: "en.wikipedia.org" },
      { url: "https://en.wikipedia.org/wiki/Stock", label: "en.wikipedia.org" },
    ]);
    expect(list.agents.map((x) => x.title)).toEqual(["First", "Second"]);
    expect(list.files).toEqual([
      { path: "a.ts", additions: 3, deletions: 1 },
      { path: "b.ts", additions: 0, deletions: 4 },
    ]);
    expect(list.links).toHaveLength(1);
  });

  it("finds the pages a step opened, by their site", () => {
    expect(urlsIn("fetched https://www.example.com/a?b=1, then (https://docs.x.ai/bot).")).toEqual(["https://www.example.com/a?b=1", "https://docs.x.ai/bot"]);
    expect(siteOf("https://www.example.com/a")).toBe("example.com");
    expect(siteOf("not a url")).toBe("not a url");
  });
});
