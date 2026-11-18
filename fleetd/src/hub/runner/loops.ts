// The hub's runner's GitHub tokens (./github.ts): as it links, and every RENEW_MS after.
import type { Hub } from "../api/hub.ts";
import { link } from "../link/index.ts";
import { every } from "../serve/every.ts";
import { RENEW_MS, RUNNER_ID, sendGithubTokens } from "./github.ts";

export function start(hub: Hub): void {
  link(hub).onLinked(({ machineId }) => {
    if (machineId === RUNNER_ID) void sendGithubTokens(hub).catch((e: unknown) => console.warn(`runner: GitHub tokens not sent: ${(e as Error).message}`));
  });
  every(hub, "runner: GitHub tokens", RENEW_MS, () => sendGithubTokens(hub));
}
