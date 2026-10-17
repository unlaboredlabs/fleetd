import { FLEETD_INSTANCE } from "@fleetd/hub/executor/ProviderList.ts";

/**
 * The fleetd Claude instance denies every T3 tool and Claude's own subagent tools, so every fan-out is a fleetd
 * task in a fleetd slot (DESIGN §3.2). T3 keeps one value per launch flag, so they share one comma-separated list.
 */
export const FLEETD_LAUNCH_ARGS = "--disallowedTools mcp__t3-code__*,Task,Workflow";

/**
 * T3's settings.json with the fleetd instance and `autoResumeLimitedThreads: false` applied, keeping everything
 * else the user or T3 stored there. Throws on a file that is not a JSON object rather than overwrite it.
 */
export const applyFleetdSettings = (existing: string | null, input: { readonly claudeDir: string }) => {
  const settings: Record<string, unknown> = existing === null ? { enableProviderUpdateChecks: false } : JSON.parse(existing);
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new Error("T3 settings.json is not a JSON object");
  const instances = (settings.providerInstances ?? {}) as Record<string, { readonly config?: Record<string, unknown> } | undefined>;
  return `${JSON.stringify(
    {
      ...settings,
      // fleetd parks a limited thread and resumes it at the reset itself; T3 resuming it too would double the turn.
      autoResumeLimitedThreads: false,
      providerInstances: {
        ...instances,
        [FLEETD_INSTANCE]: {
          ...instances[FLEETD_INSTANCE],
          driver: "claudeAgent",
          displayName: "fleetd",
          config: { ...instances[FLEETD_INSTANCE]?.config, homePath: input.claudeDir, launchArgs: FLEETD_LAUNCH_ARGS },
        },
      },
    },
    null,
    2,
  )}\n`;
};
