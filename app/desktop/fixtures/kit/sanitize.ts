// Turns a raw recording (record.ts) into a committed fixture of what the app would have seen at one moment:
//
//   node fixtures/kit/sanitize.ts --raw <raw.jsonl> --lab <lab slot dir> --out fixtures/recorded [--at start|peak|end|<ISO>]...
//
// At each moment: the last snapshot, the events after its cursor, the last full live frame and the partial ones after
// it, and per call (tool + input) its latest answer. Then everything personal or environment-specific is rewritten:
// lab machines become devbox/buildbox, the GitHub testbed acme/storefront, lab paths /home/dev/src/..., and every
// UUID, git sha and key is remapped to a stable fake. The output is refused if a leak survives (kit/leaks.ts, plus FLEETD_FIXTURE_DENYLIST, which is required).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Fixture } from "./fixture.ts";
import { sha, uuid } from "./ids.ts";
import { isObject, type JsonObject, type JsonValue, asText } from "./json.ts";
import { assertClean } from "./leaks.ts";
import type { RawLine } from "./record.ts";
import { fitStrings, validateFixture } from "./schema.ts";

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const MACHINES: Record<string, string> = { "lab-a": "devbox", "lab-b": "buildbox" };

/** The literal rewrites for one lab slot, longest first so a path goes before its prefix. */
const literalRewrites = (lab: string, hubPort: number): Array<[string, string]> => {
  const pairs: Array<[string, string]> = [
    // The one lab repo (unlaboredlabs/fleetd-lab), cloned once at the lab root and shared by every slot, and, in
    // older recordings, the slot's own testbed.
    [path.join(/^slot-\d+$/u.test(path.basename(lab)) ? path.dirname(lab) : lab, "lab-repo"), "/home/dev/src/storefront"],
    [path.join(lab, "testbed"), "/home/dev/src/storefront"],
    [path.join(lab, "repo-a"), "/home/dev/src/checkout"],
    [path.join(lab, "repo-b"), "/home/dev/src/billing"],
    // Each lab machine's own HOME is a dir in the run.
    ...Object.keys(MACHINES).map((m): [string, string] => [path.join(lab, `e2e-${hubPort}`, `home-${m}`), "/home/dev"]),
    [path.join(lab, `e2e-${hubPort}`), "/home/dev/.fleetd"],
    [lab, "/home/dev/.fleetd"],
    [os.homedir(), "/home/dev"],
    [`127.0.0.1:${hubPort}`, "devbox:4790"],
    ["unlaboredlabs/fleetd-lab", "acme/storefront"],
    ["unlaboredlabs/fleetd-testbed", "acme/storefront"],
    ["fleetd-testbed", "storefront"],
    // The lab repo's project title; its paths are rewritten above, being longer.
    ["fleetd-lab", "storefront"],
    ["repo-a", "checkout"],
    ["repo-b", "billing"],
  ];
  for (const [from, to] of Object.entries(MACHINES)) pairs.push([from, to]);
  return pairs.toSorted((a, b) => b[0].length - a[0].length);
};

const SLOT_BRANCH = /\b(?:slot|noci)\/\d+\/(?=fleetd\/|main\b)/gu;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const SHA = /\b[0-9a-f]{40}\b/gu;
// Short shas (7-12 hex with a digit and a letter), as in promptRefs ("lead.start@786007aa14") and commit summaries.
const SHORT_SHA = /\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,12}\b/gu;
const EMAIL = /(?<!\bgit)(?<![A-Za-z0-9._%+-])(?!git@github\.com\b)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,}\b/gu;
const BASE64_KEY = /\b[A-Za-z0-9+/]{43}=/gu;
const TOKENS = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|fld_[a-z2-7]{20,})/gu;
const TAILNET_V4 = /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/gu;
const TAILNET_V6 = /\bfd7a:115c:a1e0:[0-9a-f:]*/giu;
const TAILNET_HOST = /\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net\b/giu;
const HOME = /\/(?:home|Users)\/(?!dev\b)[A-Za-z0-9._-]+/gu;
// An owner/repo pair: in a GitHub URL or SSH remote (github.com:owner/repo), or a whole string under a repo-ish key.
const GITHUB_URL = /github\.com([/:])([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?=\.git\b|[/#?"\s)]|$)/giu;
const OWNER_REPO = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/u;
const REPO_KEYS = new Set(["repo", "repos", "fullName", "nameWithOwner"]);
const STAND_INS = ["storefront", "billing", "docs", "inventory", "search", "mobile", "admin", "analytics", "payments", "emails"];

export const makeSanitizer = (lab: string, hubPort: number) => {
  const literals = literalRewrites(lab, hubPort);
  const userWords = new RegExp(`\\b${escape(os.userInfo().username)}[\\w-]*`, "giu");
  /** A repo outside acme becomes an acme stand-in, the same one every time. */
  const repo = (owner: string, name: string) =>
    owner.toLowerCase() === "acme" ? `${owner}/${name}` : `acme/${STAND_INS[parseInt(sha(`${owner}/${name}`).slice(0, 6), 16) % STAND_INS.length] ?? "docs"}`;
  const text = (s: string): string => {
    let out = s;
    for (const [from, to] of literals) out = out.replaceAll(from, to);
    // The user's own logins (a GitHub author such as "<user>-dev") read as "dev".
    out = out.replace(userWords, "dev");
    // A slot's own testbed is fleetd-testbed-<n>; the literal above leaves "-<n>".
    out = out.replace(/acme\/storefront-\d\b/gu, "acme/storefront").replace(/\bstorefront-\d\b/gu, "storefront");
    // Each lab slot works in its own branch namespace of the one repo; the app shows fleetd's own branch names.
    out = out.replace(SLOT_BRANCH, "").replace(/fleetd-lab/giu, "storefront");
    out = out.replace(GITHUB_URL, (_m, sep: string, owner: string, name: string) => `github.com${sep}${repo(owner, name)}`);
    out = out.replace(/unlaboredlabs/giu, "acme");
    out = out.replace(TOKENS, "<redacted>");
    out = out.replace(TAILNET_V4, "10.0.0.2").replace(TAILNET_V6, "fd00::2").replace(TAILNET_HOST, "devbox");
    out = out.replace(HOME, "/home/dev");
    out = out.replace(UUID, (m) => uuid(m.toLowerCase()));
    out = out.replace(SHA, (m) => sha(m));
    out = out.replace(SHORT_SHA, (m) => sha(m).slice(0, m.length));
    out = out.replace(BASE64_KEY, (m) => Buffer.from(sha(m).slice(0, 32), "hex").toString("base64").slice(0, 43) + "=");
    // Commit authors and the like: a GitHub noreply address carries the account's numeric id.
    out = out.replace(EMAIL, (m) => (m.endsWith("@example.com") ? m : "dev@example.com"));
    return out;
  };
  /** A whole "owner/repo" string (a repo field, or a map key) after the other rewrites. */
  const ownerRepo = (v: string): string => {
    const out = text(v);
    const pair = OWNER_REPO.exec(out);
    return pair === null ? out : repo(pair[1] ?? "", pair[2] ?? "");
  };
  const value = (v: JsonValue, key = ""): JsonValue => {
    if (typeof v === "string") return REPO_KEYS.has(key) ? ownerRepo(v) : text(v);
    if (Array.isArray(v)) return v.map((x) => value(x, key));
    // Keys too: a map keyed by thread id, path or repo carries the same data as a value would. Only a repo map's keys
    // are read as owner/repo; elsewhere "site/pricing.md" is a path.
    const rekey = /repo/iu.test(key) ? ownerRepo : text;
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [rekey(k), value(x, k)]));
    return v;
  };
  return { text, value };
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
    options: { raw: { type: "string" }, lab: { type: "string" }, out: { type: "string" }, at: { type: "string", multiple: true }, port: { type: "string" }, name: { type: "string" } },
  });
  if (values.raw === undefined || values.lab === undefined || values.out === undefined) {
    throw new Error("usage: sanitize.ts --raw <raw.jsonl> --lab <slot dir> --out <dir> [--at start|peak|end|<ISO>]... [--name <file name, for one --at>] [--port <hub port>]");
  }
  // The generic checks can't know the recording person's own repo and host names; only their list can.
  if (process.env["FLEETD_FIXTURE_DENYLIST"] === undefined) {
    throw new Error("set FLEETD_FIXTURE_DENYLIST to a file outside the repo listing your own repo, org and host names, one per line");
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
    const name = values.name ?? `lab-${/^[a-z]+$/u.test(which) ? which : new Date(at).toISOString().slice(11, 19).replaceAll(":", "")}`;
    const fixture = sanitizeFixture(momentOf(lines, at, name, `Recorded from a lab hub at ${which}.`), s);
    fitStrings(fixture);
    const problems = validateFixture(fixture);
    if (problems.length > 0) throw new Error(`${name} isn't traffic a hub could send:\n${problems.join("\n")}`);
    const json = `${JSON.stringify(fixture.toFile(), null, 1)}\n`;
    assertClean(name, json);
    fs.writeFileSync(path.join(values.out, `${name}.json`), json);
    console.log(`${name}: ${fixture.events.length} events, ${fixture.live.length} live frames, ${fixture.calls.length} calls, ${Math.round(json.length / 1024)} KB`);
  }
};

if (import.meta.main) main();
