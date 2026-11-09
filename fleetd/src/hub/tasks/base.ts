// Where a writer's worktree started, in words (crates/fleetd/src/hub/tasks/base.rs): the spawn result, the task's
// lines, the attention item when git can't fetch the project's remote, and the doctor checks that read it.
import type { BaseErrorKind, WorktreeBase } from "../../shared/sessions.ts";

/** A fetch failure a person has to fix: credentials, a wrong URL or a repo they can't see, no default branch, else. */
export function alert(base: WorktreeBase): BaseErrorKind | undefined {
  const kind = base.error?.kind;
  return kind === "auth" || kind === "no_access" || kind === "no_default_branch" || kind === "failed" ? kind : undefined;
}

/** What the doctor's `git_fetch` flags: every `alert`, plus a machine with no ssh. */
export function doctorAlert(base: WorktreeBase): BaseErrorKind | undefined {
  return alert(base) ?? (base.error?.kind === "no_ssh" ? "no_ssh" : undefined);
}

/** The fix `fetchFailedText` names, as a doctor fix's label. */
export function fixLabel(kind: BaseErrorKind, machineId: string): string {
  switch (kind) {
    case "auth":
      return `Log git in on ${machineId}: \`gh auth login\`, or add your SSH key`;
    case "no_access":
      return "Check the remote's URL, the repo's name, and that your key or login can see it";
    case "no_default_branch":
      return "Set the remote's default branch";
    case "no_ssh":
      return `Install OpenSSH on ${machineId}`;
    default:
      return "Run `git fetch` in the project to see why";
  }
}

const short = (sha: string) => (sha.length >= 7 ? sha.slice(0, 7) : sha);
const two = (n: number) => String(n).padStart(2, "0");

/** "07:41 UTC" on the day of `now`, else "10-24 18:02 UTC". */
function when(at: string, now: string): string {
  const t = new Date(at);
  if (Number.isNaN(t.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(at)) return at;
  const n = new Date(now);
  const today =
    !Number.isNaN(n.getTime()) &&
    n.getUTCFullYear() === t.getUTCFullYear() &&
    n.getUTCMonth() === t.getUTCMonth() &&
    n.getUTCDate() === t.getUTCDate();
  const hm = `${two(t.getUTCHours())}:${two(t.getUTCMinutes())} UTC`;
  return today ? hm : `${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())} ${hm}`;
}

/** "origin/main @abc1234 as of 07:41 UTC". */
export function start(base: WorktreeBase, now: string): string {
  const at = base.fetchedAt !== undefined ? ` as of ${when(base.fetchedAt, now)}` : "";
  return `${base.ref} @${short(base.sha)}${at}`;
}

/** "based on origin/main @abc1234 as of 07:41 UTC", and why it may be behind: "(fetch failed: offline)". */
export function line(base: WorktreeBase, now: string): string {
  const error = base.error;
  if (!error) return `based on ${start(base, now)}`;
  switch (error.kind) {
    case "no_remote":
      return `based on local ${base.ref} @${short(base.sha)} (no remote)`;
    case "no_default_branch":
      return `based on ${start(base, now)} (${error.message})`;
    default:
      return `based on ${start(base, now)} (fetch failed: ${error.message})`;
  }
}

const trimDots = (s: string) => s.replace(/\.+$/, "");

/** The attention item's line and its fix command, for a base `alert` flags. */
export function fetchFailedText(project: string, base: WorktreeBase, now: string): [string, string | undefined] {
  const error = base.error;
  if (!error) return ["", undefined];
  const slash = base.ref.indexOf("/");
  const remote = slash >= 0 ? base.ref.slice(0, slash) : "its remote";
  const from = start(base, now);
  switch (error.kind) {
    case "auth":
      return [
        `git can't fetch ${remote} for ${project}: ${trimDots(error.message)}. Fix: \`gh auth login\` or your SSH key. Agents start from ${from}; their pushes will fail the same way.`,
        "gh auth login",
      ];
    case "no_access":
      return [
        `git can't fetch ${remote} for ${project}: ${trimDots(error.message)}. Fix: check the remote's URL (\`git remote get-url ${remote}\`), the repo's name, and that your key or login can see it. Agents start from ${from}.`,
        `git remote get-url ${remote}`,
      ];
    case "no_ssh":
      return [
        `ssh isn't installed, so git can't fetch ${remote} for ${project}: ${trimDots(error.message)}. Fix: install OpenSSH. Agents start from ${from}; their pushes will fail the same way.`,
        undefined,
      ];
    case "no_default_branch":
      return [
        `${error.message}, so ${project} has no default branch to start from. Fix: set the remote's default branch (on a bare repo, \`git symbolic-ref HEAD refs/heads/main\`). Agents start from ${from} meanwhile.`,
        undefined,
      ];
    default:
      return [
        `git can't fetch ${remote} for ${project}: ${trimDots(error.message)}. Fix: run \`git fetch ${remote}\` in the project to see why. Agents start from ${from}.`,
        `git fetch ${remote}`,
      ];
  }
}
