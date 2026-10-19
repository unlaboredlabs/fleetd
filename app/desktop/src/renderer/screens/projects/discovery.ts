// The hub's answers turned into what the Add project screen lists and says. Pure, so the GPUI app's tested
// behaviour (app/fleetd-app/src/project_add) carries over as tests.

import type { CloneProgressData, CloneTarget, ProjectDiscoverOutput, ProjectInspect, ProjectProblem } from "./contracts";
import { addSource, baseName, tilde } from "./source";

export interface ProjectKey {
  readonly machineId: string;
  readonly projectId: string;
}

export interface Worker {
  readonly machineId: string;
  readonly name: string;
  readonly online: boolean;
  /** Where a clone lands on it (absolute); absent when the hub doesn't say. */
  readonly cloneRoot?: string;
}

export type FoundKind = { readonly kind: "checkout"; readonly machineId: string; readonly path: string } | { readonly kind: "github" };

export interface Found {
  /** The folder's name for a checkout, "owner/repo" for GitHub. */
  readonly name: string;
  readonly source: FoundKind;
  /** The quiet text on the right: a checkout's remote, where a GitHub repo is already checked out. */
  readonly detail: string;
  readonly private: boolean;
  /** Already a project: picking it opens that project. */
  readonly project?: ProjectKey;
}

export interface Problem {
  readonly message: string;
  readonly fix?: string;
}

export interface Discovery {
  readonly workers: ReadonlyArray<Worker>;
  readonly found: ReadonlyArray<Found>;
  /** The hub's pick for a clone: online, runner ready, fewest running threads. */
  readonly best?: string;
  /** Where `gh repo list` ran, said plainly ("the hub", "devbox"); absent when gh is logged in nowhere. */
  readonly ghOn?: string;
  readonly problems: ReadonlyArray<Problem>;
}

const problem = (p: ProjectProblem): Problem => (p.fix?.trim() ? { message: p.message, fix: p.fix } : { message: p.message });

/** Each machine's checkouts, then GitHub. Machine ids read as names. */
export const discovery = (out: ProjectDiscoverOutput, name: (machineId: string) => string): Discovery => {
  const workers: Array<Worker> = [];
  const found: Array<Found> = [];
  const problems: Array<Problem> = [];
  for (const m of out.machines) {
    if (m.problem) problems.push(problem(m.problem));
    for (const r of m.repos) {
      found.push({
        name: r.name,
        source: { kind: "checkout", machineId: m.machineId, path: r.path },
        detail: r.repo ?? r.remote ?? "no remote",
        private: false,
        ...(r.projectId ? { project: { machineId: m.machineId, projectId: r.projectId } } : {}),
      });
    }
    workers.push({ machineId: m.machineId, name: name(m.machineId), online: m.online, ...(m.cloneRoot ? { cloneRoot: m.cloneRoot } : {}) });
  }
  const gh = out.github;
  if (gh.problem) problems.push(problem(gh.problem));
  for (const c of gh.repos) {
    const withProject = c.checkouts.find((k) => k.projectId !== undefined);
    const project = withProject?.projectId ? { machineId: withProject.machineId, projectId: withProject.projectId } : undefined;
    const first = c.checkouts[0];
    const detail = first && !project ? `checked out on ${name(first.machineId)}` : (c.description ?? "");
    found.push({ name: c.repo, source: { kind: "github" }, detail, private: c.private, ...(project ? { project } : {}) });
  }
  const ghOn = gh.ghOn === undefined ? undefined : gh.ghOn === "hub" ? "the hub" : name(gh.ghOn);
  return { workers, found, problems, ...(out.best ? { best: out.best } : {}), ...(ghOn ? { ghOn } : {}) };
};

/** The machine a clone or a typed path goes to: the one picked, else the hub's suggestion, else the first online. */
export const target = (d: Discovery | null, picked: string | null): Worker | null => {
  if (d === null) return null;
  const id = picked ?? d.best;
  const chosen = d.workers.find((w) => w.machineId === id && w.online);
  return chosen ?? d.workers.find((w) => w.online) ?? null;
};

export const clonePath = (w: Worker | undefined, repo: string): string | null =>
  w?.cloneRoot ? `${w.cloneRoot.replace(/\/+$/u, "")}/${baseName(repo)}` : null;

export type Row =
  | { readonly kind: "clone"; readonly repo: string }
  | { readonly kind: "folder"; readonly path: string }
  | { readonly kind: "found"; readonly index: number };

/** How well `query` matches `text`: a substring early in it beats one late, beats the letters in order. */
export const score = (query: string, text: string): number | null => {
  const q = query.toLowerCase().replace(/\s+/gu, "");
  const t = text.toLowerCase();
  if (q === "") return 0;
  const at = t.indexOf(q);
  if (at >= 0) return 1000 - at;
  let i = 0;
  for (const c of t) if (c === q[i]) i += 1;
  return i === q.length ? 100 - (t.length - q.length) / 10 : null;
};

/** The rows for what is typed, and the one to start on. */
export const rows = (text: string, found: ReadonlyArray<Found>): { rows: ReadonlyArray<Row>; selected: number } => {
  const t = text.trim();
  const src = addSource(t);
  const out: Array<Row> = [];
  if (src?.kind === "github") {
    const same = (f: Found) => f.name.toLowerCase() === src.repo.toLowerCase() || f.detail.toLowerCase() === src.repo.toLowerCase();
    out.push({ kind: "clone", repo: src.repo });
    found.forEach((f, index) => {
      if (same(f)) out.push({ kind: "found", index });
    });
  } else if (src?.kind === "path") {
    out.push({ kind: "folder", path: src.path });
  } else if (t === "") {
    found.forEach((_, index) => out.push({ kind: "found", index }));
  } else {
    const scored: Array<[number, number]> = [];
    found.forEach((f, index) => {
      const byName = score(t, f.name);
      const byDetail = score(t, f.detail);
      const best = Math.max(byName ?? -Infinity, byDetail === null ? -Infinity : byDetail / 2);
      if (best > -Infinity) scored.push([best, index]);
    });
    scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (const [, index] of scored) out.push({ kind: "found", index });
  }
  const isProject = (r: Row) => r.kind === "found" && found[r.index]?.project !== undefined;
  // A pasted repo that is already a project starts on that project (Enter opens it, not a second clone); otherwise
  // start on something that adds.
  const pasted =
    out[0]?.kind === "clone" ? out.findIndex((r) => r.kind === "found" && found[r.index]?.project !== undefined && found[r.index]?.source.kind === "github") : -1;
  const adds = out.findIndex((r) => !isProject(r));
  return { rows: out, selected: pasted >= 0 ? pasted : Math.max(adds, 0) };
};

export type Request =
  | { readonly kind: "clone"; readonly repo: string; readonly machineId: string; readonly useExisting: boolean }
  | { readonly kind: "folder"; readonly machineId: string; readonly path: string };

/** What Enter or the primary button does for the selected row. */
export type Plan =
  | { readonly kind: "clone"; readonly repo: string }
  | { readonly kind: "folder"; readonly machineId: string; readonly path: string; readonly fixed: boolean }
  | { readonly kind: "open"; readonly project: ProjectKey }
  | { readonly kind: "nothing" };

/** `picked`: the machine chosen for a typed path. It is kept even when offline (the hub then says so), never swapped. */
export const plan = (row: Row | undefined, d: Discovery | null, to: Worker | null, picked?: string): Plan => {
  if (row === undefined) return { kind: "nothing" };
  switch (row.kind) {
    case "clone":
      return { kind: "clone", repo: row.repo };
    case "folder": {
      const machineId = picked ?? to?.machineId;
      return machineId === undefined ? { kind: "nothing" } : { kind: "folder", machineId, path: row.path, fixed: false };
    }
    case "found": {
      const f = d?.found[row.index];
      if (!f) return { kind: "nothing" };
      if (f.project) return { kind: "open", project: f.project };
      if (f.source.kind === "checkout") return { kind: "folder", machineId: f.source.machineId, path: f.source.path, fixed: true };
      return { kind: "clone", repo: f.name };
    }
  }
};

export interface Ready {
  readonly project: ProjectKey;
  readonly title: string;
  readonly machine: string;
  readonly path: string;
  readonly facts: ReadonlyArray<readonly [string, string]>;
  /** The hub's one line on what the lead will need. */
  readonly leadLine: string;
  /** The repo has CI the merge train can wait on; false shows the line as a warning. */
  readonly leadOk: boolean;
  readonly notes: ReadonlyArray<string>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The ready state's facts and lead line, from what the hub inspected. */
export const ready = (project: ProjectKey, title: string, machine: string, path: string, inspect: ProjectInspect): Ready => {
  const list = (v: ReadonlyArray<string>) => v.join(", ");
  const { workflows, requiredChecks } = inspect.ci;
  const ci =
    workflows.length === 0
      ? requiredChecks.length === 0
        ? "none found"
        : `required checks ${list(requiredChecks)}, no workflows`
      : requiredChecks.length === 0
        ? `${plural(workflows.length, "workflow")} (${list(workflows)}), no required checks`
        : `${plural(workflows.length, "workflow")} (${list(workflows)}); requires ${list(requiredChecks)}`;
  const m = inspect.merge;
  const merge: Array<string> = [];
  merge.push(!m.protected ? "no branch protection or ruleset" : m.rulesets.length === 0 ? "branch protection" : `ruleset ${list(m.rulesets)}`);
  if (m.requiredReviews !== undefined && m.requiredReviews > 0) merge.push(`${plural(m.requiredReviews, "review")} required`);
  if (m.strict === true) merge.push("up to date before merging");
  merge.push(m.squashAllowed === undefined ? "merge settings unreadable" : m.squashAllowed ? "squash allowed" : "squash not allowed");
  const facts: Array<readonly [string, string]> = [
    ["Default branch", inspect.defaultBranch ?? "unknown"],
    ["CI", ci],
    ["Merge rules", merge.join(", ")],
  ];
  if (inspect.repo) facts.unshift(["Repo", inspect.repo]);
  const line = inspect.leadNeeds.trim();
  const capital = line.charAt(0).toUpperCase() + line.slice(1);
  return {
    project,
    title,
    machine,
    path,
    facts,
    leadLine: capital.endsWith(".") ? capital : `${capital}.`,
    leadOk: workflows.length > 0 || requiredChecks.length > 0,
    notes: inspect.notes,
  };
};

export type FailAction =
  /** The clone's folder already holds this repo (project_inspect said so): add it as it is. */
  | { readonly kind: "use_existing"; readonly request: Request }
  /** The hub's answer was lost with the connection and it has no record of the add: send it again. */
  | { readonly kind: "retry"; readonly request: Request }
  /** The folder is already this project. */
  | { readonly kind: "open"; readonly project: ProjectKey };

export interface Failure {
  readonly message: string;
  readonly fix?: string;
  readonly action?: FailAction;
}

/** What to offer when a clone's folder already exists: add it only when it is the same repo, open it when it is the project. */
export const existingFolderAction = (t: CloneTarget, request: Request | undefined): FailAction | undefined => {
  if (!t.exists) return undefined;
  if (t.projectId) return { kind: "open", project: { machineId: t.machineId, projectId: t.projectId } };
  if (request?.kind === "clone" && t.sameRemote) return { kind: "use_existing", request: { ...request, useExisting: true } };
  return undefined;
};

export type Step = "clone" | "inspect" | "register";

export interface Progress {
  readonly step: Step;
  readonly detail: string;
  /** Of the whole clone, 0 to 1; absent while git hasn't said. */
  readonly fraction?: number;
}

/** One bar across a clone's phases: receiving is most of it, resolving and checking out share the rest. */
export const progress = (p: CloneProgressData): Progress => {
  const pct = p.percent;
  const f = (base: number, span: number) => (pct === undefined ? undefined : base + (pct / 100) * span);
  const [step, label, fraction]: [Step, string, number | undefined] =
    p.phase === "starting"
      ? ["clone", "Starting the clone", undefined]
      : p.phase === "receiving"
        ? ["clone", "Receiving objects", f(0, 0.8)]
        : p.phase === "resolving"
          ? ["clone", "Resolving deltas", f(0.8, 0.1)]
          : p.phase === "checking_out"
            ? ["clone", "Checking out files", f(0.9, 0.1)]
            : ["inspect", "Reading the default branch, CI and merge rules", undefined];
  let detail = label;
  if (pct !== undefined && p.phase !== "inspecting") detail += ` ${pct}%`;
  if (p.detail) detail += ` · ${p.detail}`;
  return fraction === undefined ? { step, detail } : { step, detail, fraction: Math.round(fraction * 1000) / 1000 };
};

/** "devbox", "devbox or buildbox", "devbox, buildbox or ci". */
export const orList = (names: ReadonlyArray<string>): string =>
  names.length === 0 ? "your machines" : names.length === 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1) ?? ""}`;

export { tilde };
