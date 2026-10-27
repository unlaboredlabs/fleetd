// What a person pastes, types or drops, read the way the hub reads it (crates/fleetd-contracts/src/projects.rs:
// short_remote, github_repo, add_source), so the sheet offers what project_add will accept.

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const NAME = /^[A-Za-z0-9._-]{1,100}$/u;

/** GitHubRepo's own check: "owner/name". */
const isRepo = (s: string): boolean => {
  const [owner, name, ...rest] = s.split("/");
  return rest.length === 0 && owner !== undefined && name !== undefined && OWNER.test(owner) && NAME.test(name);
};

/** `git@github.com:o/r.git`, `https://github.com/o/r` → `github.com/o/r`; other URLs unchanged. */
export const shortRemote = (url: string): string => {
  let u = url.trim().replace(/\/+$/u, "");
  if (u.endsWith(".git")) u = u.slice(0, -4);
  if (u.startsWith("git@")) {
    const rest = u.slice(4);
    const colon = rest.indexOf(":");
    if (colon >= 0) return `${rest.slice(0, colon)}/${rest.slice(colon + 1)}`;
  }
  for (const scheme of ["https://", "http://", "ssh://git@", "ssh://", "git://"]) {
    if (u.startsWith(scheme)) {
      const rest = u.slice(scheme.length);
      const at = rest.lastIndexOf("@");
      return at >= 0 ? rest.slice(at + 1) : rest;
    }
  }
  return u;
};

/** The GitHub repository in a URL (a `/tree/main` tail is ignored), `github.com/o/r`, `git@github.com:o/r.git` or `o/r`. */
export const githubRepo = (text: string): string | null => {
  const t = text.trim();
  const short = shortRemote(t);
  let path: string | null = null;
  for (const host of ["github.com/", "www.github.com/"]) {
    if (short.startsWith(host)) path = short.slice(host.length).split("/").slice(0, 2).join("/");
  }
  if (path === null && !t.includes(":") && !t.includes(".") && !t.startsWith("/")) path = short;
  if (path === null) return null;
  if (path.endsWith(".git")) path = path.slice(0, -4);
  return isRepo(path) ? path : null;
};

export type AddSource = { readonly kind: "path"; readonly path: string } | { readonly kind: "github"; readonly repo: string };

/** A path when it looks like one (`/`, `~`, `.`), else a GitHub repository, else neither. */
export const addSource = (text: string): AddSource | null => {
  const t = text.trim();
  if (t === "") return null;
  if (t.startsWith("/") || t.startsWith("~") || t.startsWith(".")) return { kind: "path", path: t };
  const repo = githubRepo(t);
  return repo === null ? null : { kind: "github", repo };
};

/** A URL fleetd can't clone (not GitHub), with what to do instead. Null: it isn't a URL, or it is GitHub. */
export const otherHost = (text: string): string | null => {
  const t = text.trim();
  const prefix = ["https://", "http://", "ssh://", "git@"].find((p) => t.startsWith(p));
  if (prefix === undefined) return null;
  const host = (t.slice(prefix.length).split(/[/:]/u)[0] ?? "").replace(/^git@/u, "").toLowerCase();
  if (host === "github.com" || host === "www.github.com") return null;
  return `fleetd clones from GitHub. For a repo on ${host}, clone it on a worker yourself, then type the folder's path here.`;
};

/** The GitHub address in dropped text or a link file (.webloc, .url, .desktop). */
export const linkUrl = (content: string): string | null => {
  for (const word of content.split(/[\s<>"'=]+/u)) {
    if (word.includes("github.com") && githubRepo(word) !== null) return word;
  }
  return null;
};

/** `/home/me/src/x` and `/Users/me/src/x` read as `~/src/x`: home folders differ per machine, the rest tells repos apart. */
export const tilde = (path: string): string => {
  for (const base of ["/home/", "/Users/"]) {
    if (path.startsWith(base)) {
      const rest = path.slice(base.length);
      const slash = rest.indexOf("/");
      return slash < 0 ? "~" : `~/${rest.slice(slash + 1)}`;
    }
  }
  return path;
};

/**
 * A folder's name from a project's name, as the hub makes it (hub/navi/mod.rs slug_or): lowercase letters, digits and
 * dashes, at most 40; "project" when nothing is left.
 */
export const folderName = (name: string): string => {
  let out = "";
  for (const c of name.trim().toLowerCase()) {
    if (/^[a-z0-9]$/u.test(c)) out += c;
    else if (out !== "" && !out.endsWith("-")) out += "-";
    if (out.length >= 40) break;
  }
  out = out.replace(/-+$/u, "");
  return out === "" ? "project" : out;
};

/** The last segment of a path or "owner/repo". */
export const baseName = (path: string): string => path.replace(/\/+$/u, "").split("/").pop() ?? path;

/** The machine id `fleetd init` derives from a host name (cli/setup/machine.rs machine_id_from_host). */
export const machineIdFromHost = (host: string): string => {
  const h = host.split("@").pop() ?? host;
  const label = (h.split(".")[0] ?? h).toLowerCase();
  let id = "";
  let replacing = false;
  for (const c of label) {
    if (/[a-z0-9-]/u.test(c)) {
      id += c;
      replacing = false;
    } else if (!replacing) {
      id += "-";
      replacing = true;
    }
  }
  return id.replace(/^-+|-+$/gu, "").slice(0, 32);
};

/** A copy without `keys`: optional fields are left out, never set to undefined (exactOptionalPropertyTypes). */
export const omit = <T extends object, K extends keyof T>(o: T, ...keys: ReadonlyArray<K>): Omit<T, K> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !(keys as ReadonlyArray<PropertyKey>).includes(k))) as Omit<T, K>;
