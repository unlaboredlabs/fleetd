// Settings › Machines on the phone (admins only), as the desktop's Hub › Machines has it (D550): the machines and how
// each is, the providers the team connects with its own key (each with what it can run, from the one model in
// desktop/src/shared/providers), Tailscale (the team's tailnet for its hosted sandboxes), and what runs where. In words
// the screens show; pure, so it is tested on its own.
import type { Machine, ProviderTrouble, SandboxCheck, SandboxProviderState, SandboxState, TailnetState } from "../../desktop/src/shared/contracts";
import { hostedRow, type HostedAction, type HostedRunner, rowWords } from "../../desktop/src/shared/hostedRow";
import { specOf } from "../../desktop/src/shared/providers";

export { runnerOf, type HostedAction, type HostedRunner } from "../../desktop/src/shared/hostedRow";

export { canWords, LINUX, linuxChoices, linuxValue, MAC, machinesRun, NONE, specOf, YOURS } from "../../desktop/src/shared/providers";

/** A provider's name as people know it; one a newer hub has is shown as it names it. */
export const providerName = (p: string): string => specOf(p).name;


/** The Settings row shows for an admin. */
export const machinesShown = (admin: boolean | undefined): boolean => admin === true;

/** The team's computers, as Machines lists them: the hub's runner for hosted sandboxes is none (its provider's row
 * under Providers is where hosted shows), as on the desktop (admin/MachineList.tsx). */
export const teamMachines = <M extends Pick<Machine, "runner">>(machines: ReadonlyArray<M>): M[] => machines.filter((m) => m.runner !== true);

/** A machine's row value: Online, what the hub says is wrong, or Offline; `warn` while it needs someone. */
export const machineValue = (m: Pick<Machine, "status" | "degradedReason">): { text: string; warn: boolean } => {
  if (m.status === "online") return { text: "Online", warn: false };
  if (m.status === "degraded") {
    const why = m.degradedReason?.split(/\s+Fix:/u)[0]?.trim().replace(/[.:]$/u, "");
    return { text: why === undefined || why === "" ? "Needs a look" : why.charAt(0).toUpperCase() + why.slice(1), warn: true };
  }
  return { text: "Offline", warn: true };
};

/** A provider as Providers lists it: the hub's own state for it, with its sandboxes running now and its trouble. */
export type ProviderState = {
  id: string;
  connected: boolean;
  limit?: number;
  check?: SandboxCheck | undefined;
  running?: number | undefined;
  trouble?: ProviderTrouble | undefined;
};

/** Every provider the hub has, in the model's order. */
export const providersOf = (sandboxes: SandboxState | undefined): ProviderState[] =>
  (sandboxes?.providers ?? []).map((p: SandboxProviderState) => ({ id: p.provider, connected: p.connected, limit: p.limit, check: p.check, running: p.running, trouble: p.trouble }));

/** The provider's state as the desktop's row reads it (shared/hostedRow.ts), from what the phone has. */
const rowOf = (p: ProviderState, runner?: HostedRunner) =>
  hostedRow(
    {
      provider: p.id,
      connected: p.connected,
      limit: p.limit ?? 0,
      ...(p.check === undefined ? {} : { check: p.check }),
      ...(p.running === undefined ? {} : { running: p.running }),
      ...(p.trouble === undefined ? {} : { trouble: p.trouble }),
    },
    runner,
  );

/**
 * A provider's row value, its real state in a few words: Not connected, Starting…, how many of its limit run, Needs a
 * Claude account, Couldn't start, or its key refused. `tone` while someone has to act: `warning` for the account,
 * `problem` when it can't run.
 */
export const providerValue = (p: ProviderState, runner?: HostedRunner): { text: string; problem: boolean; warn?: boolean } => {
  const row = rowOf(p, runner);
  switch (row.state) {
    case "off":
      return { text: "Not connected", problem: false };
    case "starting":
      return { text: "Starting…", problem: false };
    case "needs_claude":
      return { text: "Needs a Claude account", problem: false, warn: true };
    case "failed":
      return { text: row.action === "test" ? "Key refused" : "Couldn't start", problem: true };
    default:
      return { text: p.limit === undefined ? "Connected" : `${String(p.running ?? 0)} of ${String(p.limit)} running`, problem: false };
  }
};

/**
 * Providers' footer: what they cost, the order, and while no machine places agents there, that none runs there yet;
 * then a line for each provider fleetd removed that the hub had connected, for a while after the update.
 */
export const providersFooter = (sandboxes: Pick<SandboxState, "removed"> | undefined): string => {
  const removed = (sandboxes?.removed ?? []).map((line) => `\n\n${line}`).join("");
  return `Your team's own accounts, which bill you. Agents go to the connected ones in this order once your machines are full.${removed}`;
};

/** The limit's choices, as an action sheet lists them: none up to 500, and the one set when it isn't among them. */
const STEPS = [0, 1, 2, 3, 5, 10, 20, 50, 100, 200, 500];
export const limitChoices = (current: number): number[] => (STEPS.includes(current) ? STEPS : [...STEPS, current].sort((a, b) => a - b));
export const limitWords = (n: number): string => (n === 0 ? "None" : String(n));

/**
 * A connected provider's footer on its screen, while someone has to act: what is wrong with its fix, in the desktop
 * row's words, and the one thing that fixes it (`action`: Connect a Claude account, Try again, Test again). Ready or
 * starting, none: the row says it.
 */
export const providerFooter = (p: ProviderState, runner?: HostedRunner): { text: string; problem: boolean; action?: HostedAction } | undefined => {
  const row = rowOf(p, runner);
  if (row.state !== "failed" && row.state !== "needs_claude") return undefined;
  return { text: rowWords(row) ?? "", problem: row.state === "failed", ...(row.action === undefined ? {} : { action: row.action }) };
};

/** How long recordings are kept: its choices, and the one set when it isn't among them. */
export const daysChoices = (current: number): number[] => [...new Set([7, 14, 30, 60, 90, 180, 365, current])].sort((a, b) => a - b);

/** How long Connect may take on the hub: a first one downloads Tailscale (2 min at most), starts it (15 s) and waits for
 * its sign-in page (30 s). */
export const CONNECT_WAIT_MS = 180_000;

/** Whether the hub waits on a sign-in or an approval: the screen reads its state again meanwhile. */
export const tailnetWaiting = (s: TailnetState | undefined): boolean => s?.status === "login" || s?.status === "approve" || s?.status === "starting";
