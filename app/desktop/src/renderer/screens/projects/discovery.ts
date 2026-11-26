// The hub's answers turned into what New bot lists and says. Pure, so its behaviour is pinned by tests.

import type { CloneProgressData, ProjectDiscoverOutput, ProjectProblem } from "./contracts";
import { addSource, tilde } from "./source";

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
  /** Where a new project's folder goes on it (absolute); absent when its node can't make one. */
  readonly projectsRoot?: string;
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

/** A reason as a sentence, as onboarding's: this module is the phone's too, whose bundle has no onboarding folder. */
const sentence = (text: string): string => (/[.?!…]$/u.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** The hub's words end without a stop, and the screen says the fix right after the problem: each as a sentence. */
const problem = (p: ProjectProblem): Problem => (p.fix?.trim() ? { message: sentence(p.message), fix: sentence(p.fix) } : { message: sentence(p.message) });

/** Whether a project can live on the machine: not the agents' Mac, which the hub refuses as a project's home. */
export const projectHome = (m: { readonly agentsMac?: boolean } | undefined): boolean => m?.agentsMac !== true;

/**
 * Each machine's checkouts, then GitHub. Machine ids read as names. `home` leaves out the machines a project can't live
 * on (projectHome): neither offered as a place for it nor listed as a source of checkouts.
 */
export const discovery = (out: ProjectDiscoverOutput, name: (machineId: string) => string, home: (machineId: string) => boolean = () => true): Discovery => {
  const workers: Array<Worker> = [];
  const found: Array<Found> = [];
  const problems: Array<Problem> = [];
  for (const m of out.machines) {
    if (!home(m.machineId)) continue;
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
    workers.push({
      machineId: m.machineId,
      name: name(m.machineId),
      online: m.online,
      ...(m.cloneRoot ? { cloneRoot: m.cloneRoot } : {}),
      ...(m.projectsRoot ? { projectsRoot: m.projectsRoot } : {}),
    });
  }
  const gh = out.github;
  if (gh.problem) problems.push(problem(gh.problem));
  for (const c of gh.repos) {
    const checkouts = c.checkouts.filter((k) => home(k.machineId));
    const withProject = checkouts.find((k) => k.projectId !== undefined);
    const project = withProject?.projectId ? { machineId: withProject.machineId, projectId: withProject.projectId } : undefined;
    const first = checkouts[0];
    const detail = first && !project ? `checked out on ${name(first.machineId)}` : (c.description ?? "");
    found.push({ name: c.repo, source: { kind: "github" }, detail, private: c.private, ...(project ? { project } : {}) });
  }
  const ghOn = gh.ghOn === undefined ? undefined : gh.ghOn === "hub" ? "the workspace" : name(gh.ghOn);
  const best = out.best !== undefined && home(out.best) ? out.best : undefined;
  return { workers, found, problems, ...(best ? { best } : {}), ...(ghOn ? { ghOn } : {}) };
};

/** The machine a clone or a typed path goes to: the one picked, else the hub's suggestion, else the first online. */
export const target = (d: Discovery | null, picked: string | null): Worker | null => {
  if (d === null) return null;
  const id = picked ?? d.best;
  const chosen = d.workers.find((w) => w.machineId === id && w.online);
  return chosen ?? d.workers.find((w) => w.online) ?? null;
};

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

/** A repo New bot can add: a GitHub repo to clone onto the bot's machine, or a folder already on it. */
export type RepoPick = ({ readonly kind: "clone"; readonly repo: string } | { readonly kind: "folder"; readonly path: string }) & { readonly detail?: string };

const pickKey = (r: RepoPick): string => (r.kind === "clone" ? `gh:${r.repo.toLowerCase()}` : `dir:${r.path.replace(/(.)\/+$/u, "$1")}`);

/**
 * What New bot offers for what is typed, at most `max`: what the text itself reads as first (a pasted repo or URL, a
 * path), then what the hub found that matches it, best first. Only checkouts on the bot's machine (`machineId`), and
 * nothing that is a bot already or listed already (`taken`, by create.ts repoKey).
 */
export const repoSuggestions = (text: string, d: Discovery | null, machineId: string | undefined, taken: ReadonlyArray<string>, max: number): ReadonlyArray<RepoPick> => {
  const t = text.trim();
  const out: Array<RepoPick> = [];
  const src = addSource(t);
  if (src?.kind === "github") out.push({ kind: "clone", repo: src.repo, detail: "from GitHub" });
  else if (src?.kind === "path") out.push({ kind: "folder", path: src.path });
  if (src?.kind !== "path") {
    const found = (d?.found ?? []).filter((f) => f.project === undefined && (f.source.kind === "github" || f.source.machineId === machineId));
    const scored = found
      .map((f) => [t === "" ? 0 : Math.max(score(t, f.name) ?? -Infinity, (score(t, f.detail) ?? -Infinity) / 2), f] as const)
      .filter(([n]) => n > -Infinity)
      .sort((a, b) => b[0] - a[0]);
    for (const [, f] of scored) {
      const r: RepoPick = f.source.kind === "checkout" ? { kind: "folder", path: f.source.path, detail: tilde(f.source.path) } : { kind: "clone", repo: f.name, ...(f.detail === "" ? {} : { detail: f.detail }) };
      if (!out.some((x) => pickKey(x) === pickKey(r))) out.push(r);
    }
  }
  return out.filter((r) => !taken.includes(pickKey(r))).slice(0, max);
};

export type Step = "clone" | "inspect" | "register";

export interface Progress {
  readonly step: Step;
  readonly detail: string;
  /** Of the whole clone, 0 to 1; absent while git hasn't said. */
  readonly fraction?: number;
}

/** The bar shows the phase git reports, at the percent the label says (git counts each phase from 0 to 100). */
export const progress = (p: CloneProgressData): Progress => {
  const pct = p.percent;
  const f = () => (pct === undefined ? undefined : pct / 100);
  const [step, label, fraction]: [Step, string, number | undefined] =
    p.phase === "starting"
      ? ["clone", "Starting the clone", undefined]
      : p.phase === "receiving"
        ? ["clone", "Receiving objects", f()]
        : p.phase === "resolving"
          ? ["clone", "Resolving deltas", f()]
          : p.phase === "checking_out"
            ? ["clone", "Checking out files", f()]
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
