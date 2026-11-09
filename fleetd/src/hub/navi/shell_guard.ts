// The one guard on a Navi's shell commands (W239): they never ask (D208),
// whatever its approval mode, but a command that would wipe the machine or the person's home is refused, with why. It
// is a short list of the obvious ones (removing `/` or the home directory recursively, making a filesystem, writing
// raw onto a disk, a fork bomb), not a sandbox: the OS sandbox stays the guard of what a command may touch.

const ROOT =
  "Refused by fleetd: this would delete everything on the machine or in your home folder. A Navi's commands never " +
  "ask, but this one never runs. Say what you meant to remove, by its own path.";
const FILESYSTEM =
  "Refused by fleetd: making a filesystem or erasing a disk wipes what's on it. A Navi never does that; the person " +
  "does it themselves.";
const DISK =
  "Refused by fleetd: writing straight onto a disk device destroys what's on it. A Navi never does that; the person " +
  "does it themselves.";
const FORK_BOMB = "Refused by fleetd: this command starts processes without end and would freeze the machine.";

/** Commands in front of another that run it: `sudo rm -rf /` is an `rm`. */
const LEADS = ["sudo", "env", "nohup", "exec", "command", "doas", "time"];

/** Why fleetd refuses `command`, or undefined: it runs. */
export function refused(command: string, home?: string): string | undefined {
  if (command.replaceAll(" ", "").includes(":(){:|:&};:")) return FORK_BOMB;
  for (const simple of command.split(/[\n;|&]/)) {
    let words = simple
      .split(/\s+/)
      .filter((w) => w !== "")
      .map((w) => w.replace(/^["']+|["']+$/g, ""));
    // `sudo`, `env`, `nohup`, `exec` and variable assignments in front run the command after them.
    while (words.length > 0) {
      const first = words[0]!;
      const lead =
        LEADS.includes(first) || (first.includes("=") && !first.startsWith("-")) || (first.startsWith("-") && words.length > 1);
      if (!lead) break;
      words = words.slice(1);
    }
    if (words.length === 0) continue;
    const [program, ...args] = words as [string, ...string[]];
    const why = wipes(program.split("/").at(-1) ?? program, args, home);
    if (why !== undefined) return why;
    // A redirect straight onto a disk: `> /dev/sda`.
    if (simple.includes(">")) {
      const target = (simple.split(">").at(-1) ?? "").trim();
      if (disk(target.split(/\s+/)[0] ?? "")) return DISK;
    }
  }
  return undefined;
}

function wipes(program: string, args: string[], home: string | undefined): string | undefined {
  switch (program) {
    case "rm": {
      const recursive = args.some(
        (a) => a === "--recursive" || (a.startsWith("-") && !a.startsWith("--") && (a.includes("r") || a.includes("R"))),
      );
      const all = args.filter((a) => !a.startsWith("-")).some((a) => everything(a, home));
      return (recursive && all) || args.includes("--no-preserve-root") ? ROOT : undefined;
    }
    case "chmod":
    case "chown":
    case "chgrp": {
      const recursive = args.some((a) => a === "-R" || a === "--recursive");
      return recursive && args.includes("/") ? ROOT : undefined;
    }
    case "wipefs":
    case "mkswap":
      return FILESYSTEM;
    case "diskutil":
      return args.some((a) => {
        const l = a.toLowerCase();
        return l.startsWith("erase") || l.startsWith("partition") || l === "zerodisk" || l === "randomdisk";
      })
        ? FILESYSTEM
        : undefined;
    case "dd":
      return args.some((a) => a.startsWith("of=") && disk(a.slice(3))) ? DISK : undefined;
    case "shred":
      return args.some(disk) ? DISK : undefined;
  }
  if (program === "mkfs" || program.startsWith("mkfs.") || program === "newfs" || program.startsWith("newfs_")) return FILESYSTEM;
  return undefined;
}

/** `/`, the home directory, or everything in one: what a recursive `rm` must never get. */
function everything(arg: string, home: string | undefined): boolean {
  let path = arg;
  while (path.endsWith("/*")) path = path.slice(0, -2);
  while (path.endsWith("*")) path = path.slice(0, -1);
  if (path.length > 1) path = path.replace(/\/+$/, "");
  const homes = ["~", "$HOME", "${HOME}", "/home", "/Users", "/root"];
  return path === "" || path === "/" || homes.includes(path) || (home !== undefined && path === home.replace(/\/+$/, ""));
}

/** A disk device: `/dev/sda`, `/dev/nvme0n1`, `/dev/disk2`, `/dev/mmcblk0`; not `/dev/null` and the like. */
function disk(path: string): boolean {
  if (!path.startsWith("/dev/")) return false;
  let dev = path.slice(5);
  if (dev.startsWith("r") && dev.slice(1).startsWith("disk")) dev = dev.slice(1);
  return ["sd", "hd", "vd", "xvd", "nvme", "disk", "mmcblk", "md", "dm-", "mapper/"].some((p) => dev.startsWith(p));
}
