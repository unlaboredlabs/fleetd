// A repo on any git host as its origin remote shortened and lowercased (crates/fleetd-contracts/src/projects.rs
// `short_remote`, work.rs `RepoKey::of`).

/** `git@github.com:acme/shop.git`, `https://user@github.com/acme/shop/` → `github.com/acme/shop`. */
export function shortRemote(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
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
      return at < 0 ? rest : rest.slice(at + 1);
    }
  }
  return u;
}

/** Whether `s` is a repo key: one lowercase line of at most 300 UTF-16 units. */
export const isRepoKey = (s: string) => s !== "" && s.length <= 300 && !/[\r\n]/.test(s) && s === s.toLowerCase();

/** The repo key of a remote in any form; undefined when it shortens to nothing. */
export function repoKeyOf(remote: string): string | undefined {
  const key = shortRemote(remote).toLowerCase();
  return isRepoKey(key) ? key : undefined;
}
