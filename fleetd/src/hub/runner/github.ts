// The hub's GitHub tokens for its own runner (./index.ts): the runner clones its bots' repos and fetches their bases on
// the hub's machine, where no computer's `gh` login is (or may be used). So the hub sends it an installation token of
// its GitHub App for each of those repos, sealed to the runner's box key: before a clone, as the runner links, and
// every RENEW_MS after, inside the token's hour (node/repos/github.ts keeps and uses them). A repo the App doesn't reach
// gets none, and its clone or fetch says GitHub refused it.
import { seal } from "../../shared/sealed_box.ts";
import { CAP_RUNNER, RUNNER_ID } from "../../shared/sandbox.ts";
import type { Hub } from "../api/hub.ts";
import { githubApps } from "../github_app/index.ts";
import { link } from "../link/index.ts";
import * as repos from "../repos/store.ts";
import { store } from "../store/hub_store.ts";

/** How often the runner's tokens are sent again: well inside an installation token's hour. */
export const RENEW_MS = 20 * 60_000;
export { RUNNER_ID };

/** `owner/name` of each GitHub repo the runner's bots hold a checkout of. */
export function runnerRepos(hub: Hub): string[] {
  const out = new Set<string>();
  for (const p of store(hub).projectsList(RUNNER_ID)) {
    for (const r of repos.of(hub.db.conn, { machineId: RUNNER_ID, projectId: p.projectId })) {
      const m = /^github\.com\/([^/]+\/[^/]+)$/u.exec(r.repoKey ?? "");
      if (m) out.add(m[1]!);
    }
  }
  return [...out].sort();
}

/** Sends the runner the App's token for each of `names` (default: its bots' repos). Quietly nothing while it isn't
 * linked or the App reaches none of them. */
export async function sendGithubTokens(hub: Hub, names: string[] = runnerRepos(hub)): Promise<void> {
  const to = store(hub).machineGet(RUNNER_ID)?.boxPubKey;
  if (names.length === 0 || to === undefined || !link(hub).can(RUNNER_ID, CAP_RUNNER)) return;
  const key = Buffer.from(to, "base64");
  const tokens: Record<string, string> = {};
  for (const name of names) {
    let token: string | undefined;
    try {
      token = await githubApps(hub).tokenFor(name);
    } catch (e) {
      console.warn(`runner: no GitHub token for ${name}: ${(e as Error).message}`);
    }
    if (token !== undefined) tokens[name] = Buffer.from(seal(key, new TextEncoder().encode(token))).toString("base64");
  }
  if (Object.keys(tokens).length === 0) return;
  await link(hub).request(RUNNER_ID, { t: "node_action", id: "", action: "github_tokens", tokens }, { waitSec: 15 });
}
