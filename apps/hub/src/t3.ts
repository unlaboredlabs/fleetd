import { ORCHESTRATION_V2_WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import pin from "../../../vendor/t3/pin.json" with { type: "json" };

/** T3 commit the vendored wire client comes from (vendor/t3/pin.json, written by `pnpm sync:t3`). */
export const T3_PIN = pin.commit;

/** npm `t3` release built from T3_PIN: what `fleetd machine add` installs and the doctor holds each machine to. */
export const T3_NPM_VERSION = pin.npm;

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
