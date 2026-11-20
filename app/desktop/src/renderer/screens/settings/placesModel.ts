// Hub › Machines' one model, apart from React: every place agents and screens run (a machine, a hosted sandbox
// provider) is a row with its state as one dot and, at its end, what it is doing or what is wrong in a few words.
// Pure so it is tested on its own.
import type { SlotSandbox } from "../../../shared/contracts";
import type { Mark } from "./parts";

/** A machine's dot: ready while online with nothing failing, needs someone otherwise. */
export const machineMark = (status: string, needs: string | undefined): Mark => (status === "online" && needs === undefined ? "ready" : "needs");

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What a well machine is doing, at its row's end: the agents running there and the screens it hosts now, only the
 * kinds it is for; Idle when nothing runs.
 */
export const loadWords = (load: { agents?: number | undefined; screens?: number | undefined }): string => {
  const parts = [
    load.agents === undefined || load.agents === 0 ? null : count(load.agents, "agent", "agents"),
    load.screens === undefined || load.screens === 0 ? null : count(load.screens, "screen", "screens"),
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? "Idle" : parts.join(" · ");
};

/** The hub's words for where a machine's agents run, after its cap's reason (hub/slots, withSandbox). */
const IN_VMS = "; each agent in a VM of its own";
const AS_PROCESSES = "; agents run as plain processes: ";

/** In VMs, but some agents not and why (`why`, `fix`: a machine signed in with `claude login`); or plain processes, and
 * `detail` behind the reason (the last VM's console), shown only when asked for. */
export type Isolation =
  | { readonly vm: true; readonly why?: string; readonly fix?: string }
  | { readonly vm: false; readonly why: string; readonly fix?: string; readonly expected: boolean; readonly detail?: string };

const sentence = (words: string): string => {
  const w = words.charAt(0).toUpperCase() + words.slice(1);
  return /[.!?…]$/u.test(w) ? w : `${w}.`;
};

/**
 * A machine's cap reason without where its agents run (a row of its own on the machine's page), and where they run:
 * the node's own `sandbox` when the hub has it, else read from the reason's words (a hub restarted a moment ago has
 * the words before the next heartbeat brings the rest). Undefined from a node that doesn't say.
 */
export const isolationOf = (why: string, sandbox?: SlotSandbox): { why: string; isolation?: Isolation } => {
  const vmAt = why.indexOf(IN_VMS);
  const procAt = why.indexOf(AS_PROCESSES);
  const at = vmAt >= 0 ? vmAt : procAt;
  const own = at < 0 ? why : why.slice(0, at);
  if (sandbox !== undefined) {
    if (sandbox.kind === "microvm")
      return { why: own, isolation: sandbox.why ? { vm: true, why: sentence(sandbox.why), ...(sandbox.fix ? { fix: sandbox.fix } : {}) } : { vm: true } };
    return {
      why: own,
      isolation: {
        vm: false,
        why: sentence(sandbox.why ?? "Its agents run as plain processes"),
        expected: sandbox.expected === true,
        ...(sandbox.fix === undefined || sandbox.expected === true ? {} : { fix: sandbox.fix }),
        ...(sandbox.detail ? { detail: sandbox.detail } : {}),
      },
    };
  }
  if (vmAt >= 0) return { why: own, isolation: { vm: true } };
  if (procAt < 0) return { why };
  const reason = why.slice(procAt + AS_PROCESSES.length).trim();
  const [said = reason, fix] = reason.split(/\s+Fix:\s+/u);
  return { why: own, isolation: { vm: false, why: sentence(said), expected: false, ...(fix === undefined || fix.trim() === "" ? {} : { fix: fix.trim() }) } };
};
