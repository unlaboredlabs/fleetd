// One `gh` run (crates/fleetd/src/hub/train/github.rs `GhRunner`, `run_gh`): what the train, the PR views and the
// GitHub App ask of GitHub goes through the `gh` CLI on the hub machine. Tests fake the runner.

export type GhOut = { exitCode: number; stdout: string; stderr: string };

/** One `gh` run; it throws why it could not start ("ENOENT" when gh is missing). */
export interface GhRunner {
  run(args: string[]): Promise<GhOut>;
}

/** Why a run could not start. */
export class GhStartError extends Error {}

const TIMEOUT_MS = 30_000;

/**
 * One run of `program` (`gh`), 30 s at most; with `token`, as that token (`GH_TOKEN`) instead of gh's own login. With
 * `env`, in only that environment (and `token`) instead of the hub's own: a stand-in's in tests.
 */
export async function runGh(program: string, args: string[], token?: string, env?: Record<string, string>): Promise<GhOut> {
  const environment: Record<string, string | undefined> = env ? { ...env } : { ...process.env };
  if (token !== undefined) environment.GH_TOKEN = token;
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([program, ...args], { env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new GhStartError(code === "ENOENT" || /ENOENT|not found/i.test(String(error)) ? "ENOENT" : String(error));
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    if (timedOut) throw new GhStartError("gh timed out after 30 s");
    return { exitCode: exitCode ?? 1, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** The real `gh` on PATH. */
export const systemGh: GhRunner = { run: (args) => runGh("gh", args) };
