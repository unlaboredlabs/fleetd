// Delete account's one confirm (App Store 5.1.1(v)), the same in Settings and on the web app's no-workspace page: what
// the delete would take, read from the cloud first, then the account's email typed back, which the cloud checks too.
import { useEffect, useRef, useState } from "react";
import type { AccountPreviewOutcome, DeleteAccountOutcome } from "../../../shared/cloud";
import { blockedLine, deleteAccountLines, emailMatches } from "../../../shared/legal";
import { Button, Dialog, Field, Input, Text } from "../../ui";
import s from "./settings.module.css";

/** Delete account's one confirm: what goes, read from the cloud first, then the account's email typed back, which the cloud checks too. */
export function DeleteAccountDialog({
  email,
  open,
  onClose,
  preview: readPreview,
  remove: deleteAccount,
  onDeleted,
}: {
  email: string;
  open: boolean;
  onClose: () => void;
  /** What the delete would take, read at each opening. */
  preview: () => Promise<AccountPreviewOutcome>;
  /** Deletes it, the typed email checked by the cloud too. */
  remove: (typed: string) => Promise<DeleteAccountOutcome>;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fix?: string | undefined } | null>(null);
  const [preview, setPreview] = useState<AccountPreviewOutcome | null>(null);
  // The caller's read as it is now (a new function each render), used only when the dialog opens.
  const reader = useRef(readPreview);
  useEffect(() => {
    reader.current = readPreview;
  });
  useEffect(() => {
    if (!open) return;
    let live = true;
    void reader.current().then((out) => {
      if (live) setPreview(out);
    });
    return () => {
      live = false;
    };
  }, [open]);
  // Read again at each opening: what goes may have changed since.
  const close = () => {
    setTyped("");
    setError(null);
    setBusy(false);
    setPreview(null);
    onClose();
  };
  const read = preview?.ok === true ? preview.preview : null;
  const blocked = read === null ? null : blockedLine(read);
  const remove = async () => {
    setBusy(true);
    setError(null);
    const out = await deleteAccount(typed);
    setBusy(false);
    if (!out.ok) {
      setError({ message: out.failure.message, fix: out.failure.fix });
      return;
    }
    close();
    onDeleted();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
      title="Delete your fleetd account?"
      description="This can't be undone."
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || read === null || blocked !== null || !emailMatches(typed, email)} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Delete account"}
          </Button>
        </>
      }
    >
      {preview === null ? (
        <span role="status">
          <Text tone="quiet">Loading…</Text>
        </span>
      ) : !preview.ok ? (
        <div role="alert">
          <Text tone="danger">{preview.failure.fix === undefined ? preview.failure.message : `${preview.failure.message} ${preview.failure.fix}`}</Text>
        </div>
      ) : blocked !== null ? (
        <div role="status">
          <Text tone="warning">{blocked}</Text>
        </div>
      ) : (
        <ul className={s.lines}>
          {deleteAccountLines(preview.preview).map((line) => (
            <li key={line}>
              <Text>{line}</Text>
            </li>
          ))}
        </ul>
      )}
      {read === null || blocked !== null ? null : (
        <Field label={`Type ${email} to confirm`}>
          <Input value={typed} type="email" autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} disabled={busy} />
        </Field>
      )}
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
