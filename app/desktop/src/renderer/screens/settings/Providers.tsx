// Every provider the team connects with its own key, as rows of one kind (Provider.tsx), from one model
// (providersModel): what each can run decides which groups list it, so Hub › Machines shows the ones that serve what a
// group is about, in the model's order, read from the hub's sandbox_get; a hub without it shows none, and one that fails
// to answer says so once, in place of them.
import type { ReactNode } from "react";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import { errorText, useLive } from "./hub";
import { GroupNote } from "./parts";
import { ordered, serves, specOf, type Capability } from "../../../shared/providers";
import { SandboxRow } from "./Sandboxes";

const noInput = {};

/** A hub too old for a provider's tool: nothing to show, and nothing wrong. */
const missing = (error: unknown): boolean => error instanceof CallError && lacksTool(error.error);

/**
 * The providers that run any of `what`, each its row; a read that failed is one line in their place. Null while there
 * is nothing to show (a hub without any of their tools, or still reading), so their group can stand back.
 */
export function useProviderRows(what: ReadonlyArray<Capability>): ReactNode {
  const live = useLive();
  const sandboxes = useToolQuery("sandbox_get", noInput, { enabled: live });
  const rows = new Map<string, ReactNode>();
  const failed: string[] = [];
  for (const p of sandboxes.data?.providers ?? []) {
    if (serves(specOf(p.provider), what)) rows.set(p.provider, <SandboxRow key={p.provider} p={p} boxPubKey={sandboxes.data?.boxPubKey ?? ""} />);
  }
  if (sandboxes.error && !missing(sandboxes.error) && what.includes("agents")) failed.push(`Couldn't read the sandbox settings: ${errorText(sandboxes.error)}`);
  if (rows.size === 0 && failed.length === 0) return null;
  return (
    <>
      {failed.map((line) => (
        <GroupNote key={line} tone="danger">
          {line}
        </GroupNote>
      ))}
      {ordered([...rows.keys()]).map((id) => rows.get(id))}
    </>
  );
}

/** The providers that run any of `what`, as rows of the group that holds them. */
export function ProviderRows({ what }: { what: ReadonlyArray<Capability> }) {
  return useProviderRows(what);
}
