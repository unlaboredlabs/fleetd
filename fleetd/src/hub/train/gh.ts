// One `gh` run (`run_gh`): what the train, the PR views and the
// GitHub App ask of GitHub goes through the `gh` CLI on the hub machine. Tests fake the runner.
import { parseApi, runApi } from "./gh_api.ts";

export type GhOut = { exitCode: number; stdout: string; stderr: string };

/** One `gh` run; it throws why it could not start ("ENOENT" when gh is missing). */
export interface GhRunner {
  run(args: string[]): Promise<GhOut>;
}

/** Why a run could not start. */
export class GhStartError extends Error {}

const TIMEOUT_MS = 30_000;
/** How long the machine's own gh login is used before gh is asked for it again: a new `gh auth login` takes then. */
const LOGIN_TTL_MS = 5 * 60_000;

/**
 * One run of `program` (`gh`), 30 s at most; with `token`, as that token (`GH_TOKEN`) instead of gh's own login. With
 * `env`, in only that environment (and `token`) instead of the hub's own: a stand-in's in tests.
 *
 * A `gh api` call of the real gh is answered in this process instead (gh_api.ts): the same answer, without a process.
 */
export async function runGh(program: string, args: string[], token?: string, env?: Record<string, string>): Promise<GhOut> {
  const call = program === "gh" && env === undefined && onGithubCom() ? parseApi(args) : undefined;
  if (call) {
    const as = token ?? (await login.token());
    if (as !== undefined) {
      let out: GhOut;
      try {
        out = await runApi(call, as);
      } catch (error) {
        if ((error as Error)?.name === "TimeoutError") throw new GhStartError("gh timed out after 30 s");
        throw error;
      }
      // A login gh no longer has (signed out, or in again as someone else) is asked for again on the next call.
      if (token === undefined && out.stderr.includes("(HTTP 401)")) login.forget();
      return out;
    }
  }
  return spawnGh(program, args, token, env);
}

/** gh talks to github.com unless `GH_HOST` names another host: those calls stay with gh. */
const onGithubCom = () => {
  const host = process.env.GH_HOST;
  return host === undefined || host === "" || host === "github.com";
};

/**
 * The machine's own gh login, as gh would pick it: `GH_TOKEN`, `GITHUB_TOKEN`, else what `gh auth token` prints, kept
 * for LOGIN_TTL_MS. Undefined without one: the call runs gh, which says it isn't signed in.
 */
const login = new (class {
  private kept: { token: string; atMs: number } | undefined;
  private asking: Promise<string | undefined> | undefined;

  async token(): Promise<string | undefined> {
    const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (env) return env;
    if (this.kept && Date.now() - this.kept.atMs < LOGIN_TTL_MS) return this.kept.token;
    this.asking ??= spawnGh("gh", ["auth", "token"])
      .then((out) => {
        const token = out.stdout.trim();
        if (out.exitCode !== 0 || token === "" || /\s/.test(token)) return undefined;
        this.kept = { token, atMs: Date.now() };
        return token;
      })
      .catch(() => undefined)
      .finally(() => (this.asking = undefined));
    return this.asking;
  }

  forget(): void {
    this.kept = undefined;
  }
})();

async function spawnGh(program: string, args: string[], token?: string, env?: Record<string, string>): Promise<GhOut> {
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
