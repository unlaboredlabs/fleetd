// `fleetd work`: the work ledger from a terminal or a hook. It reads the origin
// remote, the branch, `user.email` and the changed paths from the checkout it runs in, and calls work_claim, work_list
// and work_done over the hub's MCP endpoint.
import { ArgError, parse } from "./args.ts";
import { println, writeErr } from "./common.ts";
import { McpClient } from "./mcp_client.ts";
import { call, hubUrl, readKeyFile, Refused, reportAs } from "./steer.ts";
import { WORK_USAGE } from "./usages.ts";
export { WORK_USAGE };

const CALL_TIMEOUT = 30_000;
/** As the hub caps a claim's observed paths. */
const CHANGED_MAX = 200;

export type WorkCommand =
  | { kind: "list" }
  | {
      kind: "claim";
      title: string;
      issues: string[];
      paths: string[];
      anyway: boolean;
      notDuplicateOf: string[];
      why?: string;
    }
  | { kind: "end"; claimId?: string; landed: boolean; landing?: string };

export type WorkArgs = { command: WorkCommand; hub?: string; home?: string; keyFile: string };

const commaList = (text?: string) =>
  (text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const isClaimId = (id: string) => /^C[1-9][0-9]*$/.test(id);

/** `envKeyFile` is `$FLEETD_KEY_FILE`. */
export function parseWorkArgs(argv: string[], envKeyFile?: string): WorkArgs {
  const v = parse(argv, {
    options: {
      hub: "str",
      "key-file": "str",
      issue: "multi",
      paths: "str",
      anyway: "bool",
      "not-duplicate-of": "str",
      why: "str",
      landing: "str",
    },
    positionals: true,
  });
  if (v instanceof ArgError) throw v;
  const p = v.positionals;
  const claimOnly = ["issue", "paths", "anyway", "not-duplicate-of", "why"];
  const refuse = (names: string[], what: string) => {
    const name = names.find((n) => v.has(n));
    if (name !== undefined) throw new ArgError(`--${name} is for ${what}`);
  };
  let command: WorkCommand;
  const verb = p[0];
  if (verb === undefined || verb === "list") {
    if (p.length > 1) throw new ArgError("expected fleetd work list");
    refuse(claimOnly, "work claim");
    refuse(["landing"], "work done");
    command = { kind: "list" };
  } else if (verb === "claim") {
    refuse(["landing"], "work done");
    const title = p.slice(1).join(" ").trim();
    if (title === "") throw new ArgError(`expected fleetd work claim "<intent>"`);
    const notDuplicateOf = commaList(v.str("not-duplicate-of"));
    const why = v.str("why")?.trim() ? v.str("why") : undefined;
    if (notDuplicateOf.length > 0 && why === undefined) {
      throw new ArgError(`--not-duplicate-of needs --why "<how it is different work>"`);
    }
    command = {
      kind: "claim",
      title,
      issues: v.multi("issue"),
      paths: commaList(v.str("paths")),
      anyway: v.flag("anyway"),
      notDuplicateOf,
      ...(why === undefined ? {} : { why }),
    };
  } else if (verb === "done" || verb === "drop") {
    refuse(claimOnly, "work claim");
    if (verb === "drop" && v.has("landing")) throw new ArgError("--landing is for work done");
    const rest = p.slice(1);
    let claimId: string | undefined;
    if (rest.length === 1 && isClaimId(rest[0]!)) claimId = rest[0];
    else if (rest.length !== 0) throw new ArgError(`expected fleetd work ${verb} [C<n>]`);
    const landing = v.str("landing");
    command = {
      kind: "end",
      ...(claimId === undefined ? {} : { claimId }),
      landed: verb === "done",
      ...(landing === undefined ? {} : { landing }),
    };
  } else {
    throw new ArgError(`unknown work command '${verb}'`);
  }
  const keyFile = v.str("key-file") ?? envKeyFile;
  if (!keyFile) {
    throw new ArgError(
      "--key-file (or FLEETD_KEY_FILE) is required: the key says whose claim it is. The one Claude Code uses for the hub's MCP will do",
    );
  }
  const hub = v.str("hub") || undefined;
  return { command, ...(hub === undefined ? {} : { hub }), keyFile };
}

// ---- what the checkout says ----

export type GitFacts = {
  remote: string;
  base?: string;
  branch?: string;
  email?: string;
  head?: string;
  changed: string[];
};

function git(dir: string, args: string[]): string | undefined {
  const out = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return out.exitCode === 0 ? out.stdout.toString().trim() : undefined;
}

const lines = (text?: string) =>
  (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** The checkout's facts; Refused when `dir` is not a git checkout with an origin remote. */
export function gitFacts(dir: string): GitFacts {
  if (git(dir, ["rev-parse", "--git-dir"]) === undefined) throw new Refused(`${dir} is not in a git checkout`);
  const remote = git(dir, ["config", "--get", "remote.origin.url"]);
  if (!remote) throw new Refused("this checkout has no origin remote: fleetd knows a repo by its origin");
  const originHead = git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const base = originHead?.startsWith("origin/") ? originHead.slice(7) : undefined;
  const branch = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || undefined;
  const email = git(dir, ["config", "--get", "user.email"]) || undefined;
  const head = git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const since = (base !== undefined ? git(dir, ["merge-base", "HEAD", `origin/${base}`]) : undefined) ?? head;
  const changed = new Set<string>();
  if (since !== undefined) for (const l of lines(git(dir, ["diff", "--name-only", since]))) changed.add(l);
  for (const l of lines(git(dir, ["ls-files", "--others", "--exclude-standard"]))) changed.add(l);
  // A BTreeSet: sorted by bytes.
  const sorted = [...changed].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return {
    remote,
    ...(base === undefined ? {} : { base }),
    ...(branch === undefined ? {} : { branch }),
    ...(email === undefined ? {} : { email }),
    ...(head === undefined ? {} : { head }),
    changed: sorted.slice(0, CHANGED_MAX),
  };
}

/** work_claim's input from the checkout and the command. A branch that is the base is no work branch. */
export function claimInput(facts: GitFacts, c: WorkCommand): unknown {
  if (c.kind !== "claim") return null;
  const input: Record<string, unknown> = { repo: facts.remote, title: c.title, changed: facts.changed };
  if (facts.base !== undefined) input.base = facts.base;
  if (facts.branch !== undefined && facts.branch !== facts.base) input.branch = facts.branch;
  if (facts.email !== undefined) input.authorEmail = facts.email;
  if (facts.head !== undefined) input.headSha = facts.head;
  if (c.issues.length > 0) input.keys = c.issues.map((issue) => ({ issue }));
  if (c.paths.length > 0) input.paths = c.paths;
  if (c.anyway) input.anyway = true;
  if (c.notDuplicateOf.length > 0) {
    input.notDuplicateOf = c.notDuplicateOf;
    input.notDuplicateWhy = c.why ?? null;
  }
  return input;
}

const scopeInput = (facts: GitFacts) => ({ repo: facts.remote, ...(facts.base === undefined ? {} : { base: facts.base }) });

// ---- what it prints ----

const str = (value: any, key: string) => (typeof value?.[key] === "string" ? (value[key] as string) : "");

/** `C7  claim active  dark mode toggle  · laptop · app/theme.ts +2`. */
export function itemLine(item: any): string {
  let line = `${str(item, "id")}  ${str(item, "kind")} ${str(item, "state")}  ${str(item, "title")}`;
  if (item?.owner !== undefined) {
    const name = typeof item.owner?.label === "string" ? item.owner.label : str(item.owner, "keyId");
    line += `  · ${name}`;
  } else if (item?.projectRef !== undefined) {
    line += `  · ${str(item.projectRef, "machineId")}/${str(item.projectRef, "projectId")}`;
  }
  const paths: string[] = Array.isArray(item?.paths) ? item.paths.filter((p: unknown) => typeof p === "string") : [];
  if (paths.length === 1) line += ` · ${paths[0]}`;
  else if (paths.length > 1) line += ` · ${paths[0]} +${paths.length - 1}`;
  return line;
}

/** The claim's answer: the hub's message, each match with why, and what to do next. */
export function claimLines(answer: any): string[] {
  const out = [str(answer, "message")];
  const warning = str(answer, "warning");
  if (warning !== "") out.push(`warning: ${warning}`);
  for (const m of Array.isArray(answer?.matches) ? answer.matches : []) {
    out.push(`  ${str(m, "strength").padEnd(6)} ${itemLine(m.item)}  (${str(m, "why")})`);
  }
  const next = str(answer, "next");
  if (next !== "") out.push(`next: ${next}`);
  return out;
}

export const exitForStatus = (status: string) => (["claimed", "renewed", "yours"].includes(status) ? 0 : 1);

/** The active claim on `branch` among work_list's items: what `work done` ends when given no id. */
export function claimOnBranch(items: any[], branch: string): string | undefined {
  const on = items
    .filter((i) => str(i, "kind") === "claim" && str(i, "state") === "active")
    .filter((i) => Array.isArray(i.keys) && i.keys.some((k: any) => str(k, "branch") === branch));
  return on.length === 1 ? str(on[0], "id") : undefined;
}

async function run(args: WorkArgs, dir: string): Promise<number> {
  const facts = gitFacts(dir);
  const key = readKeyFile(args.keyFile);
  const url = hubUrl(args.hub, args.home);
  const client = await McpClient.connect(url, key, "fleetd-work", 15_000);
  const c = args.command;
  if (c.kind === "list") {
    const list = await call(client, "work_list", scopeInput(facts), CALL_TIMEOUT);
    const items: any[] = Array.isArray(list?.items) ? list.items : [];
    println(`${items.length} in flight on ${str(list?.scope, "repoKey")} ${str(list?.scope, "base")}`);
    for (const item of items) println(`  ${itemLine(item)}`);
    const warning = str(list, "warning");
    if (warning !== "") println(`warning: ${warning}`);
    return 0;
  }
  if (c.kind === "claim") {
    const answer = await call(client, "work_claim", claimInput(facts, c), CALL_TIMEOUT);
    for (const line of claimLines(answer)) println(line);
    return exitForStatus(str(answer, "status"));
  }
  let claimId = c.claimId;
  if (claimId === undefined) {
    if (facts.branch === undefined) throw new Refused("no branch is checked out: pass the claim's id (C<n>)");
    const list = await call(client, "work_list", scopeInput(facts), CALL_TIMEOUT);
    claimId = claimOnBranch(Array.isArray(list?.items) ? list.items : [], facts.branch);
    if (claimId === undefined) {
      throw new Refused(`no one active claim on ${facts.branch}: pass its id (fleetd work lists them)`);
    }
  }
  const input: Record<string, unknown> = { claimId, outcome: c.landed ? "landed" : "dropped" };
  if (c.landing !== undefined) input.landing = c.landing;
  const done = await call(client, "work_done", input, CALL_TIMEOUT);
  println(`${str(done?.claim, "claimId")} ${str(done?.claim, "state")}: ${str(done?.claim, "title")}`);
  return 0;
}

/** `fleetd work …`, in the current directory. */
export async function workCommand(argv: string[]): Promise<number> {
  let args: WorkArgs;
  try {
    args = parseWorkArgs(argv, process.env.FLEETD_KEY_FILE);
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
    writeErr(`fleetd: ${error.message}\n\nusage:\n${WORK_USAGE}`);
    return 2;
  }
  try {
    return await run(args, process.cwd());
  } catch (error) {
    return reportAs("work", error);
  }
}
