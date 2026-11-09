// What the Vault's pages share: each kind's icon, a project's name, the reads a change refetches, and a failed call in
// the person's words.
import { Braces, CreditCard, KeyRound, MapPin } from "lucide-react";
import type { ReactNode } from "react";
import { CallError } from "../../src/data/queries";
import { errorText } from "./hub";
import { useProjects } from "./parts";
import { vaultErrorWords } from "./vaultModel";

/** The vault's reads, which a change of ours (or the hub's vault events) refetch. */
export const VAULT_READS = ["vault_list", "vault_get", "vault_audit", "vault_status"] as const;

/** A vault call's failure in the person's words. */
export const vaultError = (e: unknown): string => (e instanceof CallError ? (vaultErrorWords(e.error) ?? errorText(e)) : errorText(e));

/** A project's name, for scope tags and activity. */
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
