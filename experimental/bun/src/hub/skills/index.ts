// The skills the hub keeps (crates/fleetd/src/hub/skills/mod.rs): plain skill folders (a SKILL.md and its files) under
// `<hub home>/skills`, in no repo. `global/<name>` is every project's; `projects/<machine>/<project>/<name>` is one
// project's. A folder installed from a source keeps where from and its pin in `.fleetd-install.json`, a dot-file
// sessions never get. The hub is the only writer, and every write here is synchronous, so writes never interleave.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectRef, SkillInstall, SkillOrigin, SkillScope, SkillSummary, SkillVersion } from "../../shared/contracts.ts";
import type { SkillBundle, SkillFile } from "../../shared/sessions.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { projectDirName } from "../memory/index.ts";
import { redact } from "../memory/redact.ts";
import type { HubDb } from "../store/db.ts";
import { isoMs } from "../store/time.ts";
import { checkSkillMd, descriptionOf, isSkillName, SCOPE_CAP, SKILL_BYTES_CAP, SKILL_FILE, SKILL_FILES_CAP } from "./frontmatter.ts";
import * as versions from "./versions.ts";

/** Where an installed skill's source and pin are kept, in its folder. */
export const INSTALL_FILE = ".fleetd-install.json";
/** What one launch carries, all skills together. */
const LAUNCH_BYTES_CAP = 4 * 1024 * 1024;

/** A skill folder to put in place: its name, its files (folder-relative path, bytes) and where it came from. */
export type Folder = [name: string, files: [path: string, bytes: Uint8Array][], install: SkillInstall];

export const originOf = (scope: SkillScope): SkillOrigin => (scope === "project" ? "project" : "global");

/** One skill the hub keeps, read from its folder. */
export type Kept = {
  name: string;
  scope: SkillScope;
  /** SKILL.md. */
  text: string;
  install?: SkillInstall;
  /** The other files, folder-relative, sorted. */
  files: string[];
  updatedAt?: string;
  /** Its newest version. */
  changed?: SkillVersion;
};

export function summary(k: Kept): SkillSummary {
  return {
    name: k.name,
    origin: originOf(k.scope),
    description: descriptionOf(k.text),
    ...(k.install ? { install: k.install } : {}),
    files: k.files,
    ...(k.updatedAt ? { updatedAt: k.updatedAt } : {}),
    ...(k.changed ? { changed: k.changed } : {}),
  } as SkillSummary;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The folder-relative paths of `dir`'s files, dot-files and dot-folders left out, at most one past `cap`. */
export function filesOf(dir: string, cap: number): string[] {
  const out: string[] = [];
  const stack: [string, string][] = [[dir, ""]];
  while (stack.length > 0) {
    const [at, prefix] = stack.pop() as [string, string];
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = `${prefix}${e.name}`;
      if (e.isDirectory()) stack.push([join(at, e.name), `${rel}/`]);
      else if (e.isFile()) out.push(rel);
      if (out.length > cap) break;
    }
  }
  return out.sort(cmp);
}

function writePrivate(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
}

function secretRefusal(text: string): void {
  if (redact(text) !== text) {
    throw new ToolError(
      "invalid",
      "That looks like a secret, and a skill never holds one.",
      "Leave the value out: a skill names the secret, and the agent asks for it with request_secret.",
    );
  }
}

const invalid = (message: string, fix?: string) => new ToolError("invalid", message, fix);
const ioError = (error: unknown) => new ToolError("failed", `cannot write the skill: ${(error as Error).message}`);

/** `<home>/skills`; a hub without a home keeps none. */
export const skillsDir = (hub: Hub) => (hub.config.home ? join(hub.config.home, "skills") : undefined);

/** The skills of one hub, over `<home>/skills`. */
export class Skills {
  constructor(
    private readonly db: HubDb,
    private readonly dir: string | undefined,
  ) {}

  static of(hub: Hub): Skills {
    return new Skills(hub.db, skillsDir(hub));
  }

  private root(): string {
    if (this.dir === undefined) throw new ToolError("failed", "This hub has no home to keep skills in.");
    return this.dir;
  }

  /** The scope's folder; `r` is the project for scope project. */
  scopeDir(scope: SkillScope, r?: ProjectRef): string | undefined {
    if (this.dir === undefined) return undefined;
    if (scope === "global") return join(this.dir, "global");
    return r ? join(this.dir, "projects", r.machineId, projectDirName(r)) : undefined;
  }

  private skillDir(scope: SkillScope, r: ProjectRef | undefined, name: string): string | undefined {
    const d = this.scopeDir(scope, r);
    return d === undefined ? undefined : join(d, name);
  }

  private read(scope: SkillScope, r: ProjectRef | undefined, dir: string): Kept | undefined {
    const name = dir.split("/").pop() ?? "";
    if (!isSkillName(name)) return undefined;
    const md = join(dir, SKILL_FILE);
    let text: string;
    try {
      text = readFileSync(md, "utf8");
    } catch {
      return undefined;
    }
    let install: SkillInstall | undefined;
    try {
      install = JSON.parse(readFileSync(join(dir, INSTALL_FILE), "utf8")) as SkillInstall;
    } catch {
      install = undefined;
    }
    let updatedAt: string | undefined;
    try {
      updatedAt = isoMs(Math.floor(statSync(md).mtimeMs));
    } catch {
      updatedAt = undefined;
    }
    let changed: SkillVersion | undefined;
    try {
      changed = versions.newest(this.db, scope, r, name);
    } catch (error) {
      console.warn("skills: a skill's newest version not read:", error);
    }
    return {
      name,
      scope,
      text,
      ...(install ? { install } : {}),
      files: filesOf(dir, SKILL_FILES_CAP).filter((f) => f !== SKILL_FILE),
      ...(updatedAt ? { updatedAt } : {}),
      ...(changed ? { changed } : {}),
    };
  }

  /** The scope's skills, by name. */
  list(scope: SkillScope, r?: ProjectRef): Kept[] {
    const dir = this.scopeDir(scope, r);
    if (dir === undefined) return [];
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.flatMap((n) => this.read(scope, r, join(dir, n)) ?? []).sort((a, b) => cmp(a.name, b.name));
  }

  get(scope: SkillScope, r: ProjectRef | undefined, name: string): Kept | undefined {
    const dir = this.skillDir(scope, r, name);
    return dir === undefined ? undefined : this.read(scope, r, dir);
  }

  private room(scope: SkillScope, r: ProjectRef | undefined, adding: number): void {
    const have = this.list(scope, r).length;
    if (have + adding > SCOPE_CAP) throw invalid(`This scope would hold ${have + adding} skills, past its cap of ${SCOPE_CAP}. Nothing was written.`);
  }

  /** Creates a skill or replaces its SKILL.md, kept as a new version of `who`'s; `create` refuses a name already there. */
  set(scope: SkillScope, r: ProjectRef | undefined, name: string, text: string, create: boolean, who: versions.Who): Kept {
    this.root();
    const why = checkSkillMd(name, text);
    if (why !== undefined) throw invalid(why);
    secretRefusal(text);
    const dir = this.skillDir(scope, r, name) as string;
    let exists = false;
    try {
      exists = statSync(join(dir, SKILL_FILE)).isFile();
    } catch {
      exists = false;
    }
    if (create && exists) throw invalid(`There is already a skill called ${name} here.`, "Pick another name, or open that skill to edit it.");
    if (!exists) this.room(scope, r, 1);
    try {
      const tmp = join(dir, ".SKILL.md.tmp");
      writePrivate(tmp, text);
      renameSync(tmp, join(dir, SKILL_FILE));
    } catch (error) {
      throw ioError(error);
    }
    versions.keep(this.db.conn, scope, r, name, text, who);
    return this.read(scope, r, dir) as Kept;
  }

  /** Removes a skill's folder, its versions and (in a project) its off switch; false when there was none. */
  delete(scope: SkillScope, r: ProjectRef | undefined, name: string): boolean {
    this.root();
    const dir = this.skillDir(scope, r, name) as string;
    let removed = false;
    try {
      statSync(dir);
      removed = true;
    } catch {
      removed = false;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      throw ioError(error);
    }
    const c = this.db.conn;
    versions.forget(c, scope, r, name);
    // A hub-wide skill is turned off and used per project: those go too, unless the project has its own of the name.
    if (scope === "global") {
      for (const project of versions.usesOf(c, name)) {
        const own = this.skillDir("project", project, name);
        let has = false;
        try {
          has = own !== undefined && statSync(join(own, SKILL_FILE)).isFile();
        } catch {
          has = false;
        }
        if (!has) versions.forget(c, "project", project, name);
      }
    }
    return removed;
  }

  /** Puts whole skill folders in place of any of the same names, each with its install record and a new version. */
  putFolders(scope: SkillScope, r: ProjectRef | undefined, folders: Folder[], who: versions.Who): Kept[] {
    this.root();
    const base = this.scopeDir(scope, r) as string;
    const isFile = (p: string) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    };
    this.room(scope, r, folders.filter(([name]) => !isFile(join(base, name, SKILL_FILE))).length);
    for (const [name, files] of folders) {
      const md = files.find(([p]) => p === SKILL_FILE);
      if (!md) throw invalid(`${name} has no ${SKILL_FILE}.`);
      const text = new TextDecoder().decode(md[1]);
      const why = checkSkillMd(name, text);
      if (why !== undefined) throw invalid(`${name}: ${why}`);
      secretRefusal(text);
    }
    const staging = join(base, ".staging");
    const out: Kept[] = [];
    try {
      rmSync(staging, { recursive: true, force: true });
      for (const [name, files, install] of folders) {
        for (const [rel, bytes] of files) writePrivate(join(staging, name, rel), bytes);
        writePrivate(join(staging, name, INSTALL_FILE), JSON.stringify(install, null, 2));
      }
      for (const [name] of folders) {
        const to = join(base, name);
        rmSync(to, { recursive: true, force: true });
        renameSync(join(staging, name), to);
        versions.keep(this.db.conn, scope, r, name, readFileSync(join(to, SKILL_FILE), "utf8"), who);
        out.push(this.read(scope, r, to) as Kept);
      }
      rmSync(staging, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw ioError(error);
    }
    return out;
  }

  /** What a launch in project `r` carries: the project's skills, then the global ones of other names. */
  bundles(r: ProjectRef): SkillBundle[] {
    return this.bundlesIn([r]);
  }

  /** `bundles` for a checkout several projects' skills reach: each project's in order, then the global ones. */
  bundlesIn(projects: ProjectRef[]): SkillBundle[] {
    const out: SkillBundle[] = [];
    let bytes = 0;
    let off = new Set<string>();
    try {
      off = versions.offIn(this.db, projects);
    } catch (error) {
      console.warn("skills: the skills turned off not read:", error);
    }
    const scopes: [SkillScope, ProjectRef | undefined][] = [...projects.map((r): [SkillScope, ProjectRef] => ["project", r]), ["global", undefined]];
    for (const [scope, project] of scopes) {
      for (const kept of this.list(scope, project)) {
        if (out.some((b) => b.name === kept.name) || off.has(kept.name)) continue;
        const dir = this.skillDir(scope, project, kept.name) as string;
        const files: SkillFile[] = [{ path: SKILL_FILE, text: kept.text }];
        let size = Buffer.byteLength(kept.text);
        for (const rel of kept.files) {
          // Scripts, references, templates: text. Anything else stays on the hub.
          let text: string;
          try {
            const raw = readFileSync(join(dir, rel));
            text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
          } catch {
            continue;
          }
          size += Buffer.byteLength(text);
          files.push({ path: rel, text });
        }
        if (size > SKILL_BYTES_CAP || bytes + size > LAUNCH_BYTES_CAP) {
          console.warn(`skill ${kept.name} left out of the launch: too big`);
          continue;
        }
        bytes += size;
        out.push({ name: kept.name, origin: originOf(scope), files: files.slice(0, SKILL_FILES_CAP) });
      }
    }
    return out;
  }
}

const ORIGINS: SkillOrigin[] = ["repo_agents", "repo_claude", "project", "global"];

/** Marks each skill that another of the same name outranks, and sorts the list by origin, then name. */
export function markShadowed(skills: SkillSummary[]): void {
  skills.sort((a, b) => ORIGINS.indexOf(a.origin) - ORIGINS.indexOf(b.origin) || cmp(a.name, b.name));
  skills.forEach((s, i) => {
    const winner = skills.slice(0, i).find((o) => o.name === s.name)?.origin;
    if (winner === undefined) delete s.shadowedBy;
    else s.shadowedBy = winner;
  });
}
