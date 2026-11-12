// Which modules the package may hold (the repo's root package.json `exports`, which another repository imports at a
// pinned commit; docs/CONTRIBUTING.md "The package"). An exported module is pure: neither it nor anything it imports,
// a type included, touches the database, the filesystem, a process, the network, the machine's environment, the
// Hub, or an npm package. Read from the sources' text, so it needs nothing built: an import is any `import`,
// `export … from`, `import()` or `require()`, in code or a string (a false find refuses a module; nothing is missed
// for being unusual).
//
// Run as a script it prints where every module of fleetd/src/hub, src/shared and src/gen stands:
//   bun test/pkg/purity.ts            the counts, and each module that isn't exported with why
//   bun test/pkg/purity.ts --all      the exported ones too
import { existsSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";

export type Taint = "database" | "filesystem" | "process" | "network" | "machine" | "hub" | "dependency" | "missing";

/** One thing a module does that an exported one may not: `what` in the words of the source. */
export type Use = { taint: Taint; what: string };

/** A use, the module it is in, and the imports from the entry that reach it (the entry first; empty for its own). */
export type Finding = Use & { in: string; via: string[] };

type Import = { spec: string; typeOnly: boolean };

/** Node's and Bun's own modules an exported module may import: they compute, and touch nothing outside the process. */
const PURE_BUILTINS = new Set(["path", "crypto", "zlib", "url", "util", "buffer", "events", "assert", "string_decoder"]);

const BUILTINS: [RegExp, Taint][] = [
  [/^bun:sqlite$/, "database"],
  [/^(node:)?fs(\/.*)?$/, "filesystem"],
  [/^(node:)?(child_process|worker_threads|cluster)$/, "process"],
  [/^bun:ffi$/, "process"],
  [/^(node:)?(net|http|https|http2|tls|dgram|dns)(\/.*)?$/, "network"],
  [/^(node:)?os$/, "machine"],
];

/** What a module's own code gives away. `fetch` passed in as a value is the caller's, so only a bare call counts. */
const USES: [RegExp, Taint][] = [
  [/\bBun\.(file|write|Glob|mmap)\b/, "filesystem"],
  [/\bimport\.meta\.(dir|dirname|path|file|filename)\b/, "filesystem"],
  [/\bBun\.(spawn|spawnSync|\$)/, "process"],
  [/\bnew Worker\(/, "process"],
  [/\bprocess\.(kill|exit|argv|execPath|cwd|chdir|stdin|stdout|stderr|on)\b/, "process"],
  [/\bBun\.(serve|connect|listen|udpSocket)\b/, "network"],
  [/(?<![.\w])fetch\(/, "network"],
  [/\bnew WebSocket\(/, "network"],
  [/\b(process|Bun)\.env\b/, "machine"],
];

/** The hub's handles: a module that names one, as a type too, works on a hub or its database. */
const HANDLES = new Map<string, Use>([
  ["fleetd/src/hub/api/hub.ts", { taint: "hub", what: "the Hub (src/hub/api/hub.ts)" }],
  ["fleetd/src/hub/store/db.ts", { taint: "database", what: "HubDb (src/hub/store/db.ts)" }],
]);

/** The source without its comment lines: a `//` line, and a block that opens a line. Code after code stays. */
function code(text: string): string {
  const out: string[] = [];
  let block = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (block) {
      if (t.includes("*/")) block = false;
    } else if (t.startsWith("/*")) {
      block = !t.includes("*/");
    } else if (!t.startsWith("//")) {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** One module's own imports and uses. */
export function scan(text: string): { imports: Import[]; uses: Use[] } {
  const src = code(text);
  const imports: Import[] = [];
  const uses: Use[] = [];
  const add = (spec: string, typeOnly: boolean) => {
    if (spec.startsWith(".")) return void imports.push({ spec, typeOnly });
    const name = spec.replace(/^node:/, "");
    if (PURE_BUILTINS.has(name.split("/")[0]!) && (spec.startsWith("node:") || !name.includes("/"))) return;
    const builtin = BUILTINS.find(([re]) => re.test(spec));
    uses.push({ taint: builtin?.[1] ?? "dependency", what: `imports ${spec}` });
  };
  for (const m of src.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^"'`;]*?\bfrom\s*)?["']([^"'\n]+)["']/g)) add(m[2]!, !!m[1]);
  for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']/g)) add(m[1]!, false);
  for (const [re, taint] of USES) {
    const m = re.exec(src);
    if (m) uses.push({ taint, what: `uses ${m[0].replace(/\($/, "")}` });
  }
  return { imports, uses };
}

/** Reads a source by its path from the repo's root, or undefined when there is none. */
export type Read = (path: string) => string | undefined;

type Options = {
  /** Taints this entry may have: a fake is a client, so it opens sockets. */
  allow?: Taint[];
  /** Follow only what loads at run time, leaving `import type` out: what `nearly` asks. */
  runtimeOnly?: boolean;
};

/**
 * Everything `entry` (a path from the repo's root) may not do, through whatever it imports. Empty means pure. A
 * relative import of anything but TypeScript is data (a schema, a prompt, a migration read as text) and only has to
 * exist.
 */
export function findings(entry: string, read: Read, options: Options = {}): Finding[] {
  const out: Finding[] = [];
  const from = new Map<string, string | undefined>([[entry, undefined]]);
  const queue = [entry];
  const via = (path: string): string[] => {
    const chain: string[] = [];
    for (let at = from.get(path); at !== undefined; at = from.get(at)) chain.unshift(at);
    return chain;
  };
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    const text = read(path);
    if (text === undefined) {
      out.push({ taint: "missing", what: "no such file", in: path, via: via(path) });
      continue;
    }
    if (!/\.ts$/.test(path)) continue;
    const { imports, uses } = scan(text);
    for (const use of uses) out.push({ ...use, in: path, via: via(path) });
    for (const imp of imports) {
      const to = located(read, posix.normalize(posix.join(posix.dirname(path), imp.spec)));
      const handle = HANDLES.get(to);
      if (handle) out.push({ ...handle, what: `imports ${handle.what}`, in: path, via: via(path) });
      if ((imp.typeOnly && options.runtimeOnly) || from.has(to)) continue;
      from.set(to, path);
      queue.push(to);
    }
  }
  return out.filter((f) => !options.allow?.includes(f.taint));
}

/** A relative import with no extension, as the apps' modules write them: its `.ts`, else its folder's `index.ts`. */
const located = (read: Read, to: string): string =>
  posix.extname(to) !== "" ? to : ([`${to}.ts`, `${to}/index.ts`].find((p) => read(p) !== undefined) ?? to);

/** A finding as one line: `database: src/hub/store/db.ts imports bun:sqlite (through a.ts > b.ts)`. */
export function line(f: Finding): string {
  const short = (p: string) => p.replace(/^fleetd\//, "");
  return `${f.taint}: ${short(f.in)} ${f.what}${f.via.length > 0 ? ` (through ${f.via.map(short).join(" > ")})` : ""}`;
}

export const ROOT = resolve(import.meta.dir, "../../..");

/** The repo's files, as `findings` reads them. */
export const readRepo: Read = (path) => {
  const file = join(ROOT, path);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};

/** The root package.json's `exports`: each entry's name and its file, from the repo's root. */
export function exported(): { name: string; path: string }[] {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { exports: Record<string, string> };
  return Object.entries(manifest.exports).map(([name, target]) => ({ name, path: posix.normalize(target) }));
}

/** What an entry may do beyond pure: the fakes are clients of a server at an address. */
export const allowed = (path: string): Taint[] => (path.startsWith("fleetd/test/") ? ["network"] : []);

/**
 * Pure modules of the hub the package leaves out, each with why. One listed here that stops being pure, or gets
 * exported, fails test/pkg/purity.test.ts until its line goes.
 */
export const LEFT_OUT: Record<string, string> = {
  "fleetd/src/hub/projects/avatar-worker.ts": "a worker thread's entry; the render it runs is exported (avatar-render.ts)",
  "fleetd/src/hub/tasks/lock.ts": "a lock inside one process; a second server locks rows",
  "fleetd/src/hub/train/host.ts": "the port of the train's logic, which isn't pure yet",
  "fleetd/src/hub/train/mutex.ts": "a lock inside one process; a second server locks rows",
  "fleetd/src/hub/train/repeats.ts": "a throttle for the hub's own log lines",
  "fleetd/src/shared/contracts.ts": "the hub's own path to the contracts: `fleetd/contracts` is the entry",
};

export type Standing =
  | { is: "exported"; name: string }
  | { is: "left out"; why: string }
  /** Pure, and nobody has asked for it: one line in package.json exports it. */
  | { is: "pure" }
  /** Pure at run time, but a type it imports reaches something that isn't. */
  | { is: "typed"; first: Finding }
  /** Nothing of its own: only what it imports is impure. */
  | { is: "through"; first: Finding }
  | { is: "impure"; own: Finding[] };

/** Where each module of fleetd/src/hub, src/shared and src/gen stands, by path. */
export function standings(): Map<string, Standing> {
  const names = new Map(exported().map((e) => [e.path, e.name]));
  const out = new Map<string, Standing>();
  const paths = ["hub", "shared", "gen"].flatMap((dir) =>
    [...new Bun.Glob("**/*.ts").scanSync(join(ROOT, "fleetd/src", dir))].filter((f) => !f.endsWith(".d.ts")).map((f) => `fleetd/src/${dir}/${f}`),
  );
  for (const path of paths.sort()) {
    const all = findings(path, readRepo);
    const name = names.get(path);
    if (name !== undefined) out.set(path, { is: "exported", name });
    else if (all.length === 0) out.set(path, LEFT_OUT[path] ? { is: "left out", why: LEFT_OUT[path] } : { is: "pure" });
    else if (findings(path, readRepo, { runtimeOnly: true }).length === 0) out.set(path, { is: "typed", first: all[0]! });
    else if (all.every((f) => f.via.length > 0)) out.set(path, { is: "through", first: all[0]! });
    else out.set(path, { is: "impure", own: all.filter((f) => f.via.length === 0) });
  }
  return out;
}

if (import.meta.main) {
  const all = process.argv.includes("--all");
  const counts: Record<string, number> = {};
  const short = (p: string) => relative("fleetd/src", p);
  for (const [path, s] of standings()) {
    counts[s.is] = (counts[s.is] ?? 0) + 1;
    if (s.is === "exported") all && console.log(`exported   ${short(path)}  as fleetd${s.name.slice(1)}`);
    else if (s.is === "left out") console.log(`left out   ${short(path)}  ${s.why}`);
    else if (s.is === "pure") console.log(`pure       ${short(path)}  not exported: a line in package.json's exports adds it`);
    else if (s.is === "typed") console.log(`typed      ${short(path)}  ${line(s.first)}`);
    else if (s.is === "through") console.log(`through    ${short(path)}  ${line(s.first)}`);
    else if (all) console.log(`impure     ${short(path)}  ${[...new Set(s.own.map((f) => f.taint))].join(", ")}`);
  }
  console.log(
    `\n${counts.exported ?? 0} exported, ${counts["left out"] ?? 0} pure and left out, ${counts.pure ?? 0} pure and not exported, ` +
      `${counts.typed ?? 0} pure but for a type, ${counts.through ?? 0} impure only through an import, ${counts.impure ?? 0} impure.`,
  );
}
