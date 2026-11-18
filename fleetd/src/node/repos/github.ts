// The hub's runner's own git with GitHub (hub/runner): the clones and fetches of its bots' checkouts on the hub's
// machine, which has no computer's `gh` login to lend and must never use one. The hub sends the runner an installation
// token of its GitHub App for each of its bots' repos (`node_action` github_tokens), sealed to its box key, before a
// clone and again before each one ends; the runner keeps each in `<home>/github/<owner>@<name>` (0600). Its git that
// talks to a remote then asks a credential helper of fleetd's for github.com, which answers with the token for that
// repo and nothing else, after every helper of the machine's own configuration is cleared. Never in an agent's session:
// agents in boxes get the order's own token, as every hosted agent does.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Opener = { open(sealed: Uint8Array): Uint8Array | null };

let home: string | undefined;

/** The runner's home: its git with GitHub uses the tokens kept there. Undefined everywhere else. */
export const useGithubTokens = (h: string | undefined) => void (home = h);
export const githubTokensOn = () => home !== undefined;

const dirOf = (h: string) => join(h, "github");
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Keeps each `owner/name` → token the hub sealed to this node. How many it kept. */
export function keepTokens(h: string, tokens: Record<string, string>, box: Opener): number {
  const dir = dirOf(h);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  let kept = 0;
  for (const [repo, sealed] of Object.entries(tokens)) {
    if (!REPO.test(repo) || repo.includes("..")) continue;
    const plain = box.open(new Uint8Array(Buffer.from(sealed, "base64")));
    if (!plain) continue;
    const token = new TextDecoder().decode(plain).trim();
    plain.fill(0);
    if (!/^[A-Za-z0-9_.-]{1,400}$/.test(token)) continue;
    writeFileSync(join(dir, repo.toLowerCase().replace("/", "@")), token, { mode: 0o600 });
    kept++;
  }
  return kept;
}

/** The credential helper: the kept token for the repo git asks about (its path, `owner/name[.git]`), else nothing. */
export function helper(h: string): string {
  return (
    `!f() { test "$1" = get || exit 0; p=; while IFS= read -r l; do case "$l" in path=*) p=\${l#path=};; esac; done; ` +
    `p=\${p%.git}; t=${q(dirOf(h))}/$(printf %s "$p" | tr / @ | tr A-Z a-z); test -f "$t" || exit 0; ` +
    `echo username=x-access-token; printf 'password=%s\\n' "$(cat "$t")"; }; f`
  );
}

/** Adds `key = value` to the git config `env` gives git, after the entries it has (worktree/hooks.ts's own). */
function addConfig(env: Record<string, string | undefined>, key: string, value: string): void {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  env.GIT_CONFIG_COUNT = String(n + 1);
  env[`GIT_CONFIG_KEY_${n}`] = key;
  env[`GIT_CONFIG_VALUE_${n}`] = value;
}

/** `env` for a git that talks to a remote: on the runner, GitHub answered by its kept tokens alone. */
export function withGithubTokens<E extends Record<string, string | undefined>>(env: E): E {
  if (home === undefined) return env;
  // An empty helper clears the ones before it: the machine's own (a `gh` login) are never asked.
  addConfig(env, "credential.helper", "");
  addConfig(env, "credential.https://github.com.helper", "");
  addConfig(env, "credential.https://github.com.helper", helper(home));
  addConfig(env, "credential.https://github.com.useHttpPath", "true");
  return env;
}
