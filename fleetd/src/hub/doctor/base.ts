// Where a writer's worktree started, in the words the doctor's `git_fetch` uses (crates/fleetd/src/hub/tasks/base.rs:
// doctor_alert, fix_label, start, fetch_failed_text).
import type { BaseErrorKind, WorktreeBase } from "../../shared/sessions.ts";

/** A fetch failure a person has to fix, plus a machine with no ssh: what the doctor's `git_fetch` flags. */
export function doctorAlert(base: WorktreeBase): BaseErrorKind | undefined {
  const kind = base.error?.kind;
  return kind === "auth" || kind === "no_access" || kind === "no_default_branch" || kind === "failed" || kind === "no_ssh"
    ? kind
    : undefined;
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

const short = (sha: string) => sha.slice(0, 7);
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** "07:41 UTC" on the day of `now`, else "10-24 18:02 UTC". */
function when(at: string, now: string): string {
  const t = RFC3339.test(at) ? new Date(at) : undefined;
  if (!t || Number.isNaN(t.getTime())) return at;
  const n = RFC3339.test(now) ? new Date(now) : undefined;
  const today = n !== undefined && n.toISOString().slice(0, 10) === t.toISOString().slice(0, 10);
  const hm = `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())} UTC`;
  return today ? hm : `${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${hm}`;
}

/** "origin/main @abc1234 as of 07:41 UTC". */
export function start(base: WorktreeBase, now: string): string {
  const at = base.fetchedAt === undefined ? "" : ` as of ${when(base.fetchedAt, now)}`;
  return `${base.ref} @${short(base.sha)}${at}`;
}

const trimDots = (s: string) => s.replace(/\.+$/, "");

/** The line for a failed fetch and its fix command: what failed, the fix, and where agents start from meanwhile. */
export function fetchFailedText(project: string, base: WorktreeBase, now: string): [string, string | undefined] {
  const error = base.error;
  if (!error) return ["", undefined];
  const slash = base.ref.indexOf("/");
  const remote = slash < 0 ? "its remote" : base.ref.slice(0, slash);
  const from = start(base, now);
  const said = trimDots(error.message);
  switch (error.kind) {
    case "auth":
      return [
        `git can't fetch ${remote} for ${project}: ${said}. Fix: \`gh auth login\` or your SSH key. Agents start from ${from}; their pushes will fail the same way.`,
        "gh auth login",
      ];
    case "no_access":
      return [
        `git can't fetch ${remote} for ${project}: ${said}. Fix: check the remote's URL (\`git remote get-url ${remote}\`), the repo's name, and that your key or login can see it. Agents start from ${from}.`,
        `git remote get-url ${remote}`,
      ];
    case "no_ssh":
      return [
        `ssh isn't installed, so git can't fetch ${remote} for ${project}: ${said}. Fix: install OpenSSH. Agents start from ${from}; their pushes will fail the same way.`,
        undefined,
      ];
    case "no_default_branch":
      return [
        `${error.message}, so ${project} has no default branch to start from. Fix: set the remote's default branch (on a bare repo, \`git symbolic-ref HEAD refs/heads/main\`). Agents start from ${from} meanwhile.`,
        undefined,
      ];
    default:
      return [
        `git can't fetch ${remote} for ${project}: ${said}. Fix: run \`git fetch ${remote}\` in the project to see why. Agents start from ${from}.`,
        `git fetch ${remote}`,
      ];
  }
}
