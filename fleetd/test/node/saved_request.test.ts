// Claude's saved request out of a session's conversation before a resume for fleetd's updated tools, on a real
// transcript (fixtures/claude-sessions: Claude Code 2.1.314's, a session started on a tool described "OLD-ALPHA", its
// paths and long texts cut): only those records go, every other line byte for byte; a file that isn't as expected is
// never written.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { holdsSavedRequest, savedRequestMissing, takeSavedRequest, withoutSavedRequest } from "../../src/node/sessions/saved_request.ts";
import { tempHome } from "../helpers.ts";

const FIXTURE = join(import.meta.dir, "../fixtures/claude-sessions/2.1.314-tool-changed.jsonl");
const home = tempHome();
afterAll(() => home.done());

let n = 0;
const copy = (text?: string) => {
  const file = join(home.dir, `s${++n}.jsonl`);
  if (text === undefined) copyFileSync(FIXTURE, file);
  else writeFileSync(file, text);
  chmodSync(file, 0o600);
  return file;
};
const isSaved = (line: string) => {
  const e = JSON.parse(line);
  return e.type === "api-request-shape" || (e.type === "attachment" && e.attachment?.type === "prompt_snapshot");
};

/** claude's chain of messages in `text`, as `--resume` walks it: from the last leaf back along parentUuid. */
const chain = (text: string) => {
  const entries = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const byUuid = new Map(entries.filter((e) => e.uuid).map((e) => [e.uuid, e]));
  const walked: string[] = [];
  let at: string | null = entries.filter((e) => e.type === "last-prompt").at(-1).leafUuid;
  while (at !== null) {
    const e = byUuid.get(at);
    if (!e) throw new Error(`the chain breaks at ${at}`);
    walked.push(at);
    at = e.parentUuid ?? null;
  }
  return walked.reverse();
};

test("a real transcript loses only the saved request's records, and its chain of messages stays whole", () => {
  const file = copy();
  const before = readFileSync(file, "utf8");
  expect(before).toContain("OLD-ALPHA");
  expect(holdsSavedRequest(file)).toBe(true);
  expect(takeSavedRequest(file)).toBe(3);
  const after = readFileSync(file, "utf8");
  expect(after).not.toContain("OLD-ALPHA");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  // The records that stay, in the same order: byte for byte, but for the link of those that named a snapshot.
  const kept = before.split("\n").filter((l) => l.trim() === "" || !isSaved(l));
  const now = after.split("\n");
  expect(now).toHaveLength(kept.length);
  const relinked = now.flatMap((line, i) => (line === kept[i] ? [] : [i]));
  expect(relinked).toHaveLength(3);
  for (const i of relinked) {
    const [was, is] = [JSON.parse(kept[i]!), JSON.parse(now[i]!)];
    const changed = Object.keys(was).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(is[k]));
    expect(changed.length === 1 && ["parentUuid", "leafUuid"].includes(changed[0]!)).toBe(true);
  }
  // From the leaf back to the first message, through kept records only: the whole conversation, the snapshots aside.
  const gone = new Set(before.split("\n").filter((l) => l.trim() && isSaved(l)).map((l) => JSON.parse(l).uuid).filter(Boolean));
  expect(chain(after)).toEqual(chain(before).filter((u) => !gone.has(u)));
  expect(chain(after)[0]).toBe(chain(before)[0]);
  // Once out, there is nothing more to take: a second resume for the same tools isn't asked for.
  expect(holdsSavedRequest(file)).toBe(false);
  expect(takeSavedRequest(file)).toBeUndefined();
});

test("a run of snapshots is skipped whole, and a parent the file doesn't hold leaves it as it is", () => {
  const line = (o: Record<string, unknown>) => JSON.stringify(o);
  const snap = (uuid: string, parentUuid: string | null) => line({ type: "attachment", uuid, parentUuid, attachment: { type: "prompt_snapshot" } });
  const text = [line({ type: "user", uuid: "u1", parentUuid: null }), snap("s1", "u1"), snap("s2", "s1"), line({ type: "assistant", uuid: "a1", parentUuid: "s2" }), line({ type: "last-prompt", leafUuid: "s2" }), ""].join("\n");
  expect(withoutSavedRequest(text)).toEqual({
    text: [line({ type: "user", uuid: "u1", parentUuid: null }), line({ type: "assistant", uuid: "a1", parentUuid: "u1" }), line({ type: "last-prompt", leafUuid: "u1" }), ""].join("\n"),
    taken: 2,
  });
  // The first record's own snapshot: what named it names nothing, as claude's first message does.
  expect(withoutSavedRequest([snap("s0", null), line({ type: "user", uuid: "u1", parentUuid: "s0" })].join("\n"))!.text).toBe(line({ type: "user", uuid: "u1", parentUuid: null }));
  const orphan = `${text}${line({ type: "user", uuid: "u2", parentUuid: "elsewhere" })}\n`;
  expect(withoutSavedRequest(orphan)).toBeUndefined();
  expect(savedRequestMissing(copy(orphan))).toBe("its line 6 names a parent the file doesn't hold");
});

test("a transcript that isn't as expected is never written", () => {
  const real = readFileSync(FIXTURE, "utf8");
  const stripped = withoutSavedRequest(real)!.text;
  for (const [why, text] of [
    ["a line that isn't JSON", `${real}{"type":"user"\n`],
    ["a line that is JSON but not an object", `${real}["api-request-shape"]\n`],
    ["a line that is JSON null", `null\n${real}`],
    ["none of the saved request's records", stripped],
    ["empty", ""],
  ] as const) {
    const file = copy(text);
    expect([why, holdsSavedRequest(file)]).toEqual([why, false]);
    expect([why, takeSavedRequest(file)]).toEqual([why, undefined]);
    expect([why, readFileSync(file, "utf8") === text]).toEqual([why, true]);
  }
  expect(savedRequestMissing(copy(stripped))).toBe("it holds no api-request-shape or prompt_snapshot record");
  expect(savedRequestMissing(copy(`${real}["api-request-shape"]\n`))).toBe(`its line ${real.split("\n").length} isn't a JSON object`);
  expect(savedRequestMissing(join(home.dir, "missing.jsonl"))).toBe("it can't be read");
  expect(holdsSavedRequest(join(home.dir, "missing.jsonl"))).toBe(false);
  expect(takeSavedRequest(join(home.dir, "missing.jsonl"))).toBeUndefined();
});
