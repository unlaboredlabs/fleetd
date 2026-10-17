import { ORCHESTRATION_V2_WS_METHODS, WsRpcGroup } from "@t3tools/contracts";

/** T3 commit the vendored wire client comes from. Must equal vendor/t3/PIN. */
export const T3_PIN = "2fbd4318fc5b610c3e7fcfcbd5bbd80b73521d8f";

/**
 * npm `t3` release `fleetd machine add` installs. T3_PIN has no published build of its own; this is the newest one
 * at or before it (nightly 3238 = commit 70d60e03a7). Move both together. The doctor holds each machine's T3 to it.
 */
export const T3_NPM_VERSION = "0.1.1-nightly.20261017.3238";

/**
 * The narrow executor interface fleetd drives stock T3 through (DESIGN §3.2), mapped to the
 * T3 RPC each operation uses. Send and interrupt are both orchestration commands.
 */
export const EXECUTOR_RPCS = {
  launch: ORCHESTRATION_V2_WS_METHODS.launchThread,
  send: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  interrupt: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  subscribe: ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  readItem: ORCHESTRATION_V2_WS_METHODS.getTurnItem,
  diff: ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
} as const;

/** Executor operations whose RPC the given T3 RPC group does not serve. */
export const missingExecutorRpcs = (group: { readonly requests: ReadonlyMap<string, unknown> } = WsRpcGroup) =>
  Object.entries(EXECUTOR_RPCS)
    .filter(([, tag]) => !group.requests.has(tag))
    .map(([op]) => op);
