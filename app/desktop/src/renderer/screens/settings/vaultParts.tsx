// What the Vault's pages share: each kind's icon, a project's name, the reads a change refetches, a failed call in the
// person's words, and moving a set-aside item.
import { Braces, CreditCard, KeyRound, MapPin } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import type { CallOutcome } from "../../../shared/hub";
import { CallError } from "../../src/data/queries";
import { useDataLayer } from "../../src/data/react";
import { errorText } from "./hub";
import { useProjects } from "./parts";
import { vaultErrorWords } from "./vaultModel";

/** The vault's reads, which a change of ours (or the hub's vault events) refetch. */
export const VAULT_READS = ["vault_list", "vault_get", "vault_audit", "vault_status"] as const;

/** A vault call's failure in the person's words. */
export const vaultError = (e: unknown): string => (e instanceof CallError ? (vaultErrorWords(e.error) ?? errorText(e)) : errorText(e));

/** A project's name, for activity. */
export function useProjectName(): (machineId: string, projectId: string) => string | undefined {
  const projects = useProjects();
  return (machineId, projectId) => projects?.find((p) => p.machineId === machineId && p.projectId === projectId)?.title;
}

export const KIND_ICON: Readonly<Record<string, ReactNode>> = {
  login: <KeyRound />,
  card: <CreditCard />,
  address: <MapPin />,
  env: <Braces />,
};

/**
 * vault_move: a set-aside item into the team vault, or a set-aside variable into the project named. Only a hub with the
 * team vault (vault_team) sets items aside, so only it is asked; the tool is named loosely for the contracts of hubs
 * from before it.
 */
export function useMoveSetAside() {
  const layer = useDataLayer();
  return useCallback(
    async (input: { readonly itemId: string; readonly machineId?: string; readonly projectId?: string }): Promise<void> => {
      const call = layer.call as unknown as (tool: string, input: unknown) => Promise<CallOutcome>;
      const out = await call("vault_move", input);
      if (!out.ok) throw new CallError(out.error);
    },
    [layer],
  );
}
