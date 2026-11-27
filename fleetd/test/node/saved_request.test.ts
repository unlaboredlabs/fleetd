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

test("a real transcript loses only the saved request's records, every other line byte for byte", () => {
  const file = copy();
  const before = readFileSync(file, "utf8");
  expect(before).toContain("OLD-ALPHA");
  expect(holdsSavedRequest(file)).toBe(true);
  expect(takeSavedRequest(file)).toBe(3);
  const after = readFileSync(file, "utf8");
  expect(after.split("\n")).toEqual(before.split("\n").filter((l) => l.trim() === "" || !isSaved(l)));
  expect(after).not.toContain("OLD-ALPHA");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  // Once out, there is nothing more to take: a second resume for the same tools isn't asked for.
  expect(holdsSavedRequest(file)).toBe(false);
  expect(takeSavedRequest(file)).toBeUndefined();
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
