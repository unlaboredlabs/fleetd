// Delete team: the last row of Settings' Team group, red, for a fleetd cloud team's owner only. One confirm, the
// team's name typed again, which the team checks too (fleetd cloud's POST ACCOUNTS_TEAM_DELETE_PATH); it refuses
// anyone but an owner and while any of its agents runs, in its own words, shown as written. Once deleted, main
// forgets the team (the web app goes back to its start).

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, Field, Input, Text, toast } from "../../ui";
import { useHub } from "../../src/data/react";
import { useHubRole } from "./role";

/** The confirm: the team's name exactly, around spaces. */
export const teamConfirmed = (typed: string, name: string): boolean => typed.trim() === name.trim() && name.trim() !== "";

/** Whether this app's person may delete the team in scope: a fleetd cloud team's owner. */
export function useDeletesTeam(): boolean {
  const cloud = useHub().cloud === true;
  const { me } = useHubRole();
  return cloud && me?.role === "owner";
}

export function DeleteTeamDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { id, label } = useHub();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fix?: string | undefined } | null>(null);

  const close = () => {
    setTyped("");
    setError(null);
    setBusy(false);
    onClose();
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    const out = await window.fleetd.cloud.deleteTeam(id, typed);
    setBusy(false);
    if (!out.ok) {
      setError({ message: out.failure.message, fix: out.failure.fix });
      return;
    }
    close();
    toast({ title: `${label} deleted` });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
      title={`Delete ${label}?`}
      description="Its bots, chats, memory and vault are erased for good, and everyone in it loses it."
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || !teamConfirmed(typed, label)} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Delete team"}
          </Button>
        </>
      }
    >
      <Field label={`Type ${label} to confirm`}>
        <Input value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} disabled={busy} />
      </Field>
      {error ? (
        <div role="alert">
          <Text tone="danger">{error.message}</Text>
          {error.fix ? (
            <Text as="p" tone="quiet">
              {error.fix}
            </Text>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/** The Team group's last row: red, opening the confirm. */
export function DeleteTeamItem({ className, iconClassName, labelClassName }: { className: string; iconClassName: string | undefined; labelClassName: string | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <span className={iconClassName} aria-hidden>
          <Trash2 />
        </span>
        <span className={labelClassName}>Delete team</span>
      </button>
      <DeleteTeamDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
