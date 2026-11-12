// A lead's proposal to bring items from the person's 1Password into the vault, as a card in its chat (a system
// message's `vaultImport`, vault-design §6), as the phone shows it: why it asks, each item with its kind and site,
// ticked, where they go, and Import and Dismiss. Import is the one confirm the vault has: the items are read on
// a machine holding the person's token and sealed to the hub there, so no value reaches the app, the chat or the lead.
// Where they go is the proposal's (the team vault, or a project's variables): the import names no scope of its own.
// Once answered, one quiet line says how it went.
import { useState } from "react";
import type { VaultImportCard } from "../../../shared/contracts";
import { Button, Checkbox, Text } from "../../ui";
import { useHubCall, useRefetch } from "../settings/hub";
import { importOutcome, kindWords } from "../settings/vaultModel";
import { VAULT_READS, vaultError } from "../settings/vaultParts";
import v from "../settings/vault.module.css";
import s from "./view.module.css";

/** Reading items from 1Password may install its SDK on a machine first. */
const ONEPASSWORD_MS = 240_000;

export function VaultImportCardView({ card, at }: { card: VaultImportCard; at: string }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<"import" | "dismiss" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The hub's answer arrives as the message's new state; until then the card says what was done.
  const [answered, setAnswered] = useState<string | undefined>(undefined);
  const outcome = card.state === "open" ? answered : importOutcome(card);

  if (outcome !== undefined) {
    return (
      <div className={s.event}>
        <Text size="xs" tone="quiet">
          {outcome}
        </Text>
        {problem === null ? null : (
          <Text size="xs" tone="danger">
            {problem}
          </Text>
        )}
        <span className={s.eventTime}>{at}</span>
      </div>
    );
  }

  const ticked = card.items.filter((i) => !unticked.has(i.ref));
  const run = (what: "import" | "dismiss") => {
    setBusy(what);
    setProblem(null);
    const done =
      what === "dismiss"
        ? call("vault_import", { proposalId: card.proposalId, dismiss: true }).then(() => "Not imported")
        : call("vault_import", { proposalId: card.proposalId, refs: ticked.map((i) => i.ref) }, { timeoutMs: ONEPASSWORD_MS }).then((out) => {
            if (out.errors.length > 0) setProblem(out.errors.map((e) => `${card.items.find((i) => i.ref === e.ref)?.title ?? e.ref}: ${e.message}`).join(" "));
            refetch([...VAULT_READS]);
            return importOutcome({ state: "imported", imported: out.items.length });
          });
    done.then(
      (line) => {
        setBusy(null);
        setAnswered(line);
      },
      (e: unknown) => {
        setBusy(null);
        setProblem(vaultError(e));
      },
    );
  };

  return (
    <section className={v.card} aria-label="Import from 1Password" data-vault-import={card.proposalId}>
      <div className={v.cardHead}>
        <Text strong>Import from 1Password</Text>
        <Text size="xs" tone="quiet">{card.scope === "project" || card.scope === "order" ? "Into the project's variables" : "Into the team vault"}</Text>
      </div>
      {card.why.trim() === "" ? null : <Text size="sm">{card.why}</Text>}
      <div className={v.picks} role="group" aria-label="Items">
        {card.items.map((i) => (
          <Checkbox
            key={i.ref}
            label={i.title}
            description={[kindWords(i.kind).one, i.site].filter((x) => x !== undefined && x !== "").join(" · ")}
            checked={!unticked.has(i.ref)}
            disabled={busy !== null}
            onCheckedChange={(c) =>
              setUnticked((was) => {
                const next = new Set(was);
                if (c === true) next.delete(i.ref);
                else next.add(i.ref);
                return next;
              })
            }
          />
        ))}
      </div>
      <Text size="xs" tone="quiet">
        Read on your machine and sealed there. The lead never sees a value.
      </Text>
      {problem === null ? null : (
        <div role="alert">
          <Text size="xs" tone="danger">
            {problem}
          </Text>
        </div>
      )}
      <div className={v.bar}>
        <Button variant="secondary" disabled={busy !== null} onClick={() => run("dismiss")}>
          {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
        </Button>
        <Button variant="primary" disabled={busy !== null || ticked.length === 0} onClick={() => run("import")}>
          {busy === "import" ? "Importing…" : ticked.length === card.items.length ? "Import" : `Import ${String(ticked.length)}`}
        </Button>
        <span className={s.eventTime}>{at}</span>
      </div>
    </section>
  );
}
