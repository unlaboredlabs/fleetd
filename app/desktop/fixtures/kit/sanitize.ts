// Turns a raw recording (record.ts) into a committed fixture of what the app would have seen at one moment:
//
//   node fixtures/kit/sanitize.ts --raw <raw.jsonl> --lab <lab slot dir> --out fixtures/recorded [--at start|peak|end|<ISO>]...
//
// At each moment: the last snapshot, the events after its cursor, the last full live frame and the partial ones after
// it, and per call (tool + input) its latest answer. Then everything personal or environment-specific is rewritten:
// lab machines become devbox/buildbox, the GitHub testbed acme/storefront, lab paths /home/dev/src/..., and every
// UUID, git sha and key is remapped to a stable fake. The output is refused if a known personal string survives.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Fixture } from "./fixture.ts";
import { sha, uuid } from "./ids.ts";
import { isObject, type JsonObject, type JsonValue, asText } from "./json.ts";
import type { RawLine } from "./record.ts";
import { fitStrings, validateFixture } from "./schema.ts";

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Strings that must never reach a committed fixture, whatever the rewrite missed: this machine's user and host, the lab. */
const FORBIDDEN = [
  ...[os.userInfo().username, os.hostname()].filter((w) => w.length >= 3).map((w) => new RegExp(`\\b${escape(w)}\\b`, "iu")),
  /unlaboredlabs/iu,
  /fleetd-lab/iu,
  /fleetd-testbed/iu,
  // Tailnet addresses (100.64.0.0/10) and names.
  /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b/u,
  /\.ts\.net\b/iu,
  /fld_[a-z2-7]{20,}/u,
];

const MACHINES: Record<string, string> = { "lab-a": "devbox", "lab-b": "buildbox" };

/** The literal rewrites for one lab slot, longest first so a path goes before its prefix. */
const literalRewrites = (lab: string, hubPort: number): Array<[string, string]> => {
  const home = path.dirname(path.dirname(path.dirname(lab)));
  const pairs: Array<[string, string]> = [
    [path.join(lab, "testbed"), "/home/dev/src/storefront"],
    [path.join(lab, "repo-a"), "/home/dev/src/checkout"],
    [path.join(lab, "repo-b"), "/home/dev/src/billing"],
    // Each lab machine's own HOME is a dir in the run.
    ...Object.keys(MACHINES).map((m): [string, string] => [path.join(lab, `e2e-${hubPort}`, `home-${m}`), "/home/dev"]),
    [path.join(lab, `e2e-${hubPort}`), "/home/dev/.fleetd"],
    [lab, "/home/dev/.fleetd"],
    [home, "/home/dev"],
    [`127.0.0.1:${hubPort}`, "devbox:4790"],
    ["unlaboredlabs/fleetd-testbed", "acme/storefront"],
    ["fleetd-testbed", "storefront"],
    ["unlaboredlabs", "acme"],
    ["repo-a", "checkout"],
    ["repo-b", "billing"],
  ];
  for (const [from, to] of Object.entries(MACHINES)) pairs.push([from, to]);
  return pairs.toSorted((a, b) => b[0].length - a[0].length);
};

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const SHA = /\b[0-9a-f]{40}\b/gu;
// Short shas (7-12 hex with a digit and a letter), as in promptRefs ("lead.start@786007aa14") and commit summaries.
const SHORT_SHA = /\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,12}\b/gu;
const BASE64_KEY = /\b[A-Za-z0-9+/]{43}=/gu;

export const makeSanitizer = (lab: string, hubPort: number) => {
  const literals = literalRewrites(lab, hubPort);
  const userWords = new RegExp(`\\b${escape(os.userInfo().username)}[\\w-]*`, "giu");
  const text = (s: string): string => {
    let out = s;
    for (const [from, to] of literals) out = out.replaceAll(from, to);
    // The user's own logins (a GitHub author such as "<user>-dev") read as "dev".
    out = out.replace(userWords, "dev");
    // A slot's own testbed is fleetd-testbed-<n>; the literal above leaves "-<n>".
    out = out.replace(/acme\/storefront-\d\b/gu, "acme/storefront").replace(/\bstorefront-\d\b/gu, "storefront");
    out = out.replace(UUID, (m) => uuid(m.toLowerCase()));
    out = out.replace(SHA, (m) => sha(m));
    out = out.replace(SHORT_SHA, (m) => sha(m).slice(0, m.length));
    out = out.replace(BASE64_KEY, (m) => Buffer.from(sha(m).slice(0, 32), "hex").toString("base64").slice(0, 43) + "=");
    out = out.replace(/fld_[a-z2-7]{20,}/gu, "fld_redacted");
    return out;
  };
  const value = (v: JsonValue): JsonValue => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(value);
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)]));
    return v;
  };
  return { text, value };
};

/**
 * FLEETD_FIXTURE_DENYLIST=<file>: more words that must never appear, one per line, such as the recording person's
 * own repo names. Kept outside the repo, since the list itself would say what it hides.
 */
export const denylist = (): Array<RegExp> => {
  const file = process.env["FLEETD_FIXTURE_DENYLIST"];
  if (file === undefined) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((w) => w.trim())
    .filter((w) => w.length >= 3)
    .map((w) => new RegExp(`(?<![A-Za-z0-9])${escape(w)}(?![A-Za-z0-9])`, "iu"));
};

export const assertClean = (name: string, json: string) => {
  for (const pattern of [...FORBIDDEN, ...denylist()]) {
    const hit = pattern.exec(json);
    if (hit !== null) throw new Error(`${name}: "${json.slice(Math.max(0, hit.index - 60), hit.index + 60)}" still matches ${pattern}`);
  }
};

const readRaw = (file: string): Array<RawLine> =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RawLine);

/** The moment the recording was busiest: the end of the sweep in which one order had the most lanes. */
const peakOf = (lines: ReadonlyArray<RawLine>): number => {
  let best = { lanes: -1, at: 0 };
  for (const l of lines) {
    if (l.kind !== "result" || l.tool !== "order_get" || !isObject(l.output ?? null)) continue;
    const order = (l.output as JsonObject)["order"];
    const lanes = isObject(order) && Array.isArray(order["lanes"]) ? order["lanes"].length : 0;
    if (lanes > best.lanes) best = { lanes, at: l.at };
  }
  // The rest of that sweep: up to the next sweep's start.
  const next = lines.find((l) => l.kind === "mark" && l.what.startsWith("sweep") && l.at > best.at);
  return next === undefined ? best.at + 10_000 : next.at - 1;
};

/** What the app would hold at `at`: see the header. */
export const momentOf = (lines: ReadonlyArray<RawLine>, at: number, name: string, note: string): Fixture => {
  const f = new Fixture(name, note);
  f.now = new Date(at).toISOString();
  const before = lines.filter((l) => l.at <= at);
  const frames = before.flatMap((l) => (l.kind === "frame" ? [l.frame] : []));
  const snapshot = frames.findLast((fr) => fr["t"] === "snapshot");
  if (snapshot !== undefined) {
    const { t: _t, ...rest } = snapshot;
    f.snapshot = rest;
  }
  const cursor = typeof f.snapshot?.["cursor"] === "number" ? f.snapshot["cursor"] : 0;
  const seenSeq = new Set<number>();
  for (const fr of frames) {
    if (fr["t"] !== "event" || typeof fr["seq"] !== "number" || fr["seq"] <= cursor || seenSeq.has(fr["seq"])) continue;
    seenSeq.add(fr["seq"]);
    const { t: _t, ...event } = fr;
    f.events.push(event);
  }
  const live = frames.filter((fr) => fr["t"] === "live");
  const lastFull = live.findLastIndex((fr) => fr["full"] === true);
  if (lastFull >= 0) f.live = live.slice(lastFull).map(({ t: _t, ...rest }) => rest);
  for (const l of before) {
    if (l.kind !== "result") continue;
    if (l.output !== undefined) f.answer(l.tool, l.input, l.output);
    else if (l.error !== undefined) {
      const { code, message, fix } = l.error;
      f.fail(l.tool, l.input, { code: asText(code), message: asText(message), ...(typeof fix === "string" ? { fix } : {}) });
    }
  }
  return f;
};

/** The GitHub repos a person can see are theirs, not the lab's: project_discover lists stand-ins instead. */
export const ACME_REPOS: Array<JsonObject> = [
  { repo: "acme/storefront", url: "https://github.com/acme/storefront", private: false, description: "Marketing site and checkout for the Team plan", pushedAt: "2026-10-19T08:12:00Z", checkouts: [] },
  { repo: "acme/billing", url: "https://github.com/acme/billing", private: true, description: "Invoices, receipts and the nightly export", pushedAt: "2026-10-18T17:40:00Z", checkouts: [] },
  { repo: "acme/docs", url: "https://github.com/acme/docs", private: false, description: "Public docs site", pushedAt: "2026-10-16T09:05:00Z", checkouts: [] },
];

const withoutPersonalRepos = (tool: string, output: JsonValue): JsonValue => {
  if (tool !== "project_discover" || !isObject(output) || !isObject(output["github"])) return output;
  return { ...output, github: { ...output["github"], owners: ["acme"], repos: ACME_REPOS } };
};

/** Every string in the fixture rewritten; inputs too, so they still match what the screens will ask for. */
export const sanitizeFixture = (f: Fixture, s: ReturnType<typeof makeSanitizer>): Fixture => {
  const out = Fixture.from(f, f.name, f.note);
  if (out.snapshot !== undefined) out.snapshot = s.value(out.snapshot) as JsonObject;
  out.events = out.events.map((e) => s.value(e) as JsonObject);
  out.live = out.live.map((e) => s.value(e) as JsonObject);
  out.calls = out.calls.map((c) => ({
    ...c,
    input: c.input === undefined ? undefined : (s.value(c.input) as JsonObject),
    ...(c.output === undefined ? {} : { output: s.value(withoutPersonalRepos(c.tool, c.output)) }),
    ...(c.error === undefined ? {} : { error: { ...c.error, message: s.text(c.error.message), ...(c.error.fix === undefined ? {} : { fix: s.text(c.error.fix) }) } }),
  }));
  return out;
};

const main = () => {
  const { values } = parseArgs({
    options: { raw: { type: "string" }, lab: { type: "string" }, out: { type: "string" }, at: { type: "string", multiple: true }, port: { type: "string" } },
  });
  if (values.raw === undefined || values.lab === undefined || values.out === undefined) {
    throw new Error("usage: sanitize.ts --raw <raw.jsonl> --lab <slot dir> --out <dir> [--at start|peak|end|<ISO>]... [--port <hub port>]");
  }
  const lines = readRaw(values.raw);
  const slot = Number(/slot-(\d)/u.exec(values.lab)?.[1] ?? 0);
  const s = makeSanitizer(path.resolve(values.lab), Number(values.port ?? 4795 + 20 * slot));
  fs.mkdirSync(values.out, { recursive: true });
  for (const which of values.at ?? ["start", "peak"]) {
    const at =
      which === "peak"
        ? peakOf(lines)
        : which === "end"
          ? (lines.at(-1)?.at ?? 0)
          : which === "start"
            ? // Just before the hub's first event: the first sweep's answers, nothing happened yet.
              (lines.find((l) => l.kind === "frame" && l.frame["t"] === "event")?.at ?? 1) - 1
            : Date.parse(which);
    const name = `lab-${/^[a-z]+$/u.test(which) ? which : new Date(at).toISOString().slice(11, 19).replaceAll(":", "")}`;
    const fixture = sanitizeFixture(momentOf(lines, at, name, `Recorded from a lab hub at ${which}.`), s);
    fitStrings(fixture);
    const problems = validateFixture(fixture);
    for (const p of problems) console.warn(`schema: ${p}`);
    const json = `${JSON.stringify(fixture.toFile(), null, 1)}\n`;
    assertClean(name, json);
    fs.writeFileSync(path.join(values.out, `${name}.json`), json);
    console.log(`${name}: ${fixture.events.length} events, ${fixture.live.length} live frames, ${fixture.calls.length} calls, ${Math.round(json.length / 1024)} KB`);
  }
};

if (import.meta.main) main();
