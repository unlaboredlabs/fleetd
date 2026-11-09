// Which project a lead call's cwd belongs to (crates/fleetd/src/hub/link/cwd.rs). Pure.

/** Lexical normal form without a trailing slash (`path.posix.normalize`). The hub can't see the node's filesystem, so
 * symlinks stay as given. */
export function normalize(p: string): string {
  const absolute = p.startsWith("/");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      const last = parts.at(-1);
      if (last !== undefined && last !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  const joined = parts.join("/");
  if (absolute) return `/${joined}`;
  return joined === "" ? "." : joined;
}

const contains = (root: string, cwd: string) => cwd === root || cwd.startsWith(root === "/" ? "/" : `${root}/`);

/**
 * The index of the project whose workspace root is `cwd` or one of its ancestors, so worktrees under the root count.
 * With nested roots the deepest wins; with equal roots, the first (newest activity first from the store).
 */
export function projectIndexForCwd(roots: Iterable<string>, cwd: string): number | undefined {
  const target = normalize(cwd);
  let best: [index: number, depth: number] | undefined;
  let i = 0;
  for (const raw of roots) {
    const root = normalize(raw);
    // UTF-16 length, as older hubs compared it: a JS string's length.
    if (root.startsWith("/") && contains(root, target) && (best === undefined || root.length > best[1])) {
      best = [i, root.length];
    }
    i++;
  }
  return best?.[0];
}

const MAX_LISTED_ROOTS = 5;

/** `[message, fix]` of the refusal for a cwd outside every project on the machine. */
export function outsideEveryProject(machineId: string, cwd: string, roots: string[]): [string, string] {
  if (roots.length === 0) {
    return [
      `the hub knows no projects on ${machineId} yet, so it cannot tell which project ${cwd} belongs to`,
      `check that the node on ${machineId} is online and has added the project (fleetd_status), then run the command again`,
    ];
  }
  const listed = roots.slice(0, MAX_LISTED_ROOTS).join(", ");
  const more = roots.length > MAX_LISTED_ROOTS ? ` and ${roots.length - MAX_LISTED_ROOTS} more` : "";
  return [
    `${cwd} is not inside any project workspace on ${machineId}`,
    `run fleetd from the project's workspace or a worktree under it (${listed}${more})`,
  ];
}
