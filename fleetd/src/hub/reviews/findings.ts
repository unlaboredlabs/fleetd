// A PR's reviews as review_read shows them, without the database (read.ts reads them): a review task's newest verdict,
// a person's open finding as shown, and whether a PR's URL or number names a PR.
import type { PersonFinding } from "./people_rules.ts";
import { prKey } from "./verdict_input.ts";

/** One review task's newest verdict on the newest head reviewed (contracts `ReviewFindings`). */
export type ReviewFindings = {
  taskId: string;
  prHeadSha?: string;
  blocking: number;
  nonBlocking: number;
  findings: string;
  at: string;
};

/** A person's review on GitHub still open on the PR, as its last read found it. */
export type PeopleFinding = { by: string; kind: "changes" | "thread"; where?: string; url: string; said: { by: string; text: string }[] };

export const at = (f: PersonFinding) => (f.path === undefined ? undefined : f.line === undefined ? f.path : `${f.path}:${f.line}`);

export function peopleFinding(f: PersonFinding): PeopleFinding {
  const where = at(f);
  return { by: f.by, kind: f.kind, ...(where !== undefined ? { where } : {}), url: f.url, said: f.said };
}

/** Whether `wanted`, a PR's URL or its number (`#7`, `7`), names `pr`. */
export function names(wanted: string, pr: string): boolean {
  const key = prKey(pr);
  const n = wanted.replace(/^#+/, "");
  return /^\d+$/.test(n) ? key.endsWith(`/pull/${BigInt(n)}`) : key === prKey(wanted);
}
