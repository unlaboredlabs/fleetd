// A check run and a commit status as GitHub reports them on a head, and the workflow run and job behind a check
// (github.ts reads them).

export type CheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string | null;
  /** GitHub's own stamps, whole seconds. */
  started_at?: string | null;
  completed_at?: string | null;
  head_sha?: string | null;
};

/** The workflow run that reported it, from its page (`.../actions/runs/<id>/job/<job>`). */
export function workflowRun(run: CheckRun): number | undefined {
  const url = run.html_url ?? "";
  const at = url.indexOf("/actions/runs/");
  if (at < 0) return undefined;
  const id = url.slice(at + "/actions/runs/".length).split("/")[0] ?? "";
  return /^\d+$/.test(id) ? Number(id) : undefined;
}

/** The Actions job behind it, from its page (`.../job/<job>`). */
export function jobOf(run: CheckRun): number | undefined {
  const url = run.html_url ?? "";
  const at = url.indexOf("/job/");
  if (at < 0) return undefined;
  const id = url.slice(at + 5).split(/[/?#]/)[0] ?? "";
  return /^\d+$/.test(id) ? Number(id) : undefined;
}

/** A commit status on a head, as GitHub's combined status lists it. */
export type CommitStatus = { context: string; state: string; target_url?: string | null };
