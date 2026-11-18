// The hub's runner's GitHub tokens (./github.ts): as it links, and every RENEW_MS after. The team's Claude accounts
// (claude_accounts/runner.ts): as it or a machine holding one links.
import type { Hub } from "../api/hub.ts";
import { toRunner } from "../claude_accounts/runner.ts";
import { executors } from "../executor/index.ts";
import { link } from "../link/index.ts";
import { every } from "../serve/every.ts";
import { RENEW_MS, RUNNER_ID, sendGithubTokens } from "./github.ts";

export function start(hub: Hub): void {
  link(hub).onLinked(({ machineId }) => {
    // Once the link is live, so the hand-off's calls go through.
    void executors(hub)
      .awaitLive(machineId, hub.shutdown.signal)
      .then(() => toRunner(hub))
      .catch(() => {});
    if (machineId === RUNNER_ID) void sendGithubTokens(hub).catch((e: unknown) => console.warn(`runner: GitHub tokens not sent: ${(e as Error).message}`));
  });
  every(hub, "runner: GitHub tokens", RENEW_MS, () => sendGithubTokens(hub));
}
