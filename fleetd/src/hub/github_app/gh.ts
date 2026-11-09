// The hub's `gh`, as the App where it can (crates/fleetd/src/hub/github_app/gh.rs): each run about a repository the
// App is installed on gets that installation's token in `GH_TOKEN`; any other run, or one while GitHub can't mint a
// token, uses the hub machine's own `gh` login, as before the App. A run GitHub refuses to the App itself ("Resource
// not accessible by integration") runs once more on the machine's login; any other failure is the run's own.
import { type GhOut, type GhRunner, runGh } from "../train/gh.ts";
import type { GithubApps } from "./index.ts";

export class AppGh implements GhRunner {
  /**
   * `program` instead of `gh`, in only `env` (and the App's token): a stand-in in tests, which so never sees what the
   * test process inherited (an agent's own `GH_TOKEN`).
   */
  constructor(
    private readonly apps: GithubApps,
    private readonly program = "gh",
    private readonly env?: Record<string, string>,
  ) {}

  async run(args: string[]): Promise<GhOut> {
    const repo = repoOf(args);
    const token = repo === undefined ? undefined : await this.apps.tokenFor(repo);
    if (token === undefined) return runGh(this.program, args, undefined, this.env);
    const out = await runGh(this.program, args, token, this.env);
    if (out.exitCode !== 0 && refusedApp(out.stderr)) {
      console.warn(`github app: GitHub refused the App on gh ${args[0] ?? ""}; running it on the machine's login`);
      return runGh(this.program, args, undefined, this.env);
    }
    return out;
  }
}

/** GitHub's words when an App's token may not do what was asked. */
const refusedApp = (text: string) => text.includes("Resource not accessible by integration");

/**
 * The repository (`owner/name`) a `gh` run is about, as the hub's calls name it: `--repo`/`-R`, a `repos/<owner>/
 * <name>` API path, or GraphQL's `owner=` and `name=` fields. Undefined for anything else (`gh api user`).
 */
export function repoOf(args: string[]): string | undefined {
  let owner: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--repo" || arg === "-R") {
      const r = args[i + 1];
      return r !== undefined && isRepo(r) ? r : undefined;
    }
    if (arg.startsWith("--repo=")) {
      const r = arg.slice("--repo=".length);
      return isRepo(r) ? r : undefined;
    }
    if (arg === "-f" || arg === "-F") {
      const field = args[i + 1];
      if (field !== undefined) {
        if (field.startsWith("owner=")) owner = field.slice(6);
        else if (field.startsWith("name=")) name = field.slice(5);
      }
      i++;
      continue;
    }
    const path = arg.startsWith("/") ? arg.slice(1) : arg;
    if (path.startsWith("repos/")) {
      const [o, n] = path.slice(6).split(/[/?]/);
      if (o !== undefined && n !== undefined) {
        const repo = `${o}/${n}`;
        if (isRepo(repo)) return repo;
      }
    }
  }
  if (owner === undefined || name === undefined) return undefined;
  const repo = `${owner}/${name}`;
  return isRepo(repo) ? repo : undefined;
}

function isRepo(r: string): boolean {
  const ok = (s: string) => /^[A-Za-z0-9._-]+$/.test(s);
  const slash = r.indexOf("/");
  return slash >= 0 && ok(r.slice(0, slash)) && ok(r.slice(slash + 1));
}
