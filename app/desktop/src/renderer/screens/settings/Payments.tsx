// A project's Payments (its Projects page; D265): the card its lead pays with, and every purchase it made
// (project_purchases). On a hub with a vault the card is one of the vault's cards the project's work can use (its own,
// yours shared with it, the hub's: vault_list with usable), kept as `vault:<id>`, with Add a card and Import from
// 1Password beside them; on an older hub, a Credit Card item from the person's own 1Password (onepassword_cards lists
// them; project_card_set keeps only its op:// reference). A purchase fills the card in at its checkout without asking (D312), and the chat says what
// was paid. One section on its own, so it can go without touching the rest.
import { useState } from "react";
import type { OnePasswordCardsOutput } from "../../../shared/contracts";
import { Button, InlineCode, Select, Text } from "../../ui";
import { useData, useToolQuery } from "../../src/data/react";
import { useNow } from "../live";
import { cardLabel, NO_CARD, cardOptions, PAYMENTS_HELP, purchaseLine, purchaseState } from "../projects/payments";
import { PROJECT_TOOLS } from "../projects/model";
import { when } from "../live/when";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { SettingsList, SettingsListRow, SettingsRow } from "./parts";
import { ImportDialog, VaultEditor } from "./VaultForms";
import { rowLine, scopeTag, vaultServed } from "./vaultModel";
import { useProjectName, vaultError } from "./vaultParts";
import s from "./settings.module.css";

type Ref = { machineId: string; projectId: string };

/** Listing the cards may install the 1Password SDK on the machine first. */
const CARDS_MS = 240_000;

/** Payments' help on a hub with a vault: the card comes from there. */
const VAULT_HELP =
  "The card it pays with at a checkout, from the vault. fleetd fills it in at the checkout, and the project never sees it. Use a virtual or low-limit card, never your main one. Each purchase is listed below, with the shop and the total.";

/** A picked card's name: a vault card's label, never its raw `vault:` id. */
const pickedName = (card: { ref: string; label?: string }): string => card.label ?? (card.ref.startsWith("vault:") ? "a card no longer in the vault" : cardLabel(card));

export function PaymentsSetting({ projectRef }: { projectRef: Ref }) {
  const vault = useData((d) => vaultServed(d.features));
  const live = useLive();
  const nowMs = useNow(true, 60_000);
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const read = useToolQuery(PROJECT_TOOLS.purchases, projectRef, { enabled: live });
  const [picking, setPicking] = useState(false);
  // The cards are read when the person opens the picker, and only then: listing them may take minutes the first time.
  const [cards, setCards] = useState<{ data?: OnePasswordCardsOutput; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const card = read.data?.card;
  const purchases = read.data?.purchases ?? [];

  const open = (): void => {
    setPicking(true);
    // The vault's cards are a quick read, made by the picker itself.
    if (vault) return;
    setCards(null);
    // On the project's machine, with the token its fills read the card with.
    hubCall("onepassword_cards", { navi: projectRef }, { timeoutMs: CARDS_MS }).then(
      (data) => setCards({ data }),
      (e: unknown) => setCards({ error: errorText(e) }),
    );
  };

  const pick = (value: string): void => {
    setSaving(true);
    setProblem(null);
    hubCall(PROJECT_TOOLS.cardSet, { ...projectRef, ...(value === NO_CARD ? {} : { card: value }) }).then(
      () => {
        setSaving(false);
        setPicking(false);
        refetch([PROJECT_TOOLS.purchases]);
      },
      (e: unknown) => {
        setSaving(false);
        setProblem(errorText(e));
      },
    );
  };

  return (
    <SettingsRow
      reveal="projects.payments"
      title="Payments"
      line={
        read.isLoadingError
          ? errorText(read.error)
          : read.data === undefined
            ? live
              ? "Loading…"
              : "Not connected."
            : card === undefined
              ? "No card: the lead can't pay at a checkout."
              : `Pays with ${pickedName(card)}.`
      }
      hint={vault ? VAULT_HELP : PAYMENTS_HELP}
      lineTone={read.isLoadingError ? "danger" : "quiet"}
      control={
        read.data === undefined ? undefined : picking && vault ? (
          <Button variant="secondary" disabled={saving} onClick={() => setPicking(false)}>
            Cancel
          </Button>
        ) : picking ? (
          cards?.error !== undefined || cards?.data?.error !== undefined ? (
            <>
              <Button variant="secondary" disabled={!live} onClick={open}>
                Try again
              </Button>
              <Button variant="secondary" onClick={() => setPicking(false)}>
                Cancel
              </Button>
            </>
          ) : cards?.data === undefined ? (
            <Text size="sm" tone="quiet">
              Reading your 1Password…
            </Text>
          ) : (
            <>
              <Select
                id="project-card"
                aria-label="Card"
                value={card?.ref ?? NO_CARD}
                disabled={saving}
                options={cardOptions(cards.data.cards, card?.ref)}
                onValueChange={pick}
              />
              <Button variant="secondary" disabled={saving} onClick={() => setPicking(false)}>
                Cancel
              </Button>
            </>
          )
        ) : (
          <Button variant="secondary" disabled={!live} onClick={open}>
            {card === undefined ? "Pick a card…" : "Change…"}
          </Button>
        )
      }
    >
      {read.data === undefined ? null : (
        <>
          {picking && vault ? <VaultCards projectRef={projectRef} picked={card?.ref} pickedLabel={card?.label} saving={saving} onPick={pick} /> : null}
          {picking && !vault && (cards?.error !== undefined || cards?.data?.error !== undefined) ? (
            <div role="alert">
              <Text size="sm" tone="danger">
                {cards.error ?? `1Password: ${cards.data?.error ?? ""}`}
              </Text>
            </div>
          ) : null}
          {picking && !vault && cards?.data !== undefined && cards.data.error === undefined && cards.data.cards.length === 0 ? (
            <Text size="sm" tone="quiet">
              Your 1Password token reads no Credit Card item. Add the card to a vault it reads, then try again.
            </Text>
          ) : null}
          {problem === null ? null : (
            <div role="alert">
              <Text size="sm" tone="danger">
                {problem}
              </Text>
            </div>
          )}
          {purchases.length === 0 ? (
            card === undefined ? null : (
              <Text size="sm" tone="quiet">
                No purchases yet.
              </Text>
            )
          ) : (
            <SettingsList label="Purchases">
              {purchases.map((p) => {
                const line = purchaseLine(p);
                return (
                  <SettingsListRow
                    key={p.requestId}
                    label={line.shop}
                    name={
                      // The name is the lead's words; the domain is where the card was filled, so the log can't be spoofed.
                      <>
                        {`${line.shop} · `}
                        <InlineCode>{p.purchase.shop.domain}</InlineCode>
                      </>
                    }
                    controls={
                      <Text tabular className={s.purchaseAmount}>
                        {line.amount}
                      </Text>
                    }
                  >
                    <Text size="sm" tone="quiet">
                      {`${purchaseState(p)} · asked ${when(p.askedAt, nowMs)}${p.answeredBy === undefined ? "" : ` · by ${p.answeredBy.replace(/^human:/u, "")}`} · ${cardLabel(p.purchase.card)}`}
                    </Text>
                  </SettingsListRow>
                );
              })}
            </SettingsList>
          )}
        </>
      )}
    </SettingsRow>
  );
}

/**
 * The vault's cards this project's work can use, to pick from, with No card; and Add a card or Import from 1Password,
 * which picks what was added.
 */
function VaultCards(props: { projectRef: Ref; picked: string | undefined; pickedLabel: string | undefined; saving: boolean; onPick: (value: string) => void }) {
  const { projectRef } = props;
  const live = useLive();
  const projectName = useProjectName();
  // usable: what the project's work may pay with (its own, yours shared with it, the hub's), not
  // only its own.
  const list = useToolQuery("vault_list", { ...projectRef, kind: "card", usable: true }, { enabled: live });
  const [adding, setAdding] = useState<"card" | "import" | null>(null);
  const whose = { kind: "project", ...projectRef } as const;
  const cards = (list.data?.items ?? []).filter((c) => c.kind === "card" && c.deletedMs === undefined);
  const options = cards.map((c) => {
    const tag = scopeTag(c, projectName);
    return { value: `vault:${c.itemId}`, label: [c.label, rowLine(c), tag === undefined ? "yours" : tag].join(" · ") };
  });
  // A card picked that the list doesn't have (gone, or a 1Password one from before the vault): by its label from the
  // purchases read, never a raw `vault:` id.
  if (props.picked !== undefined && !options.some((o) => o.value === props.picked)) {
    options.unshift({ value: props.picked, label: props.pickedLabel ?? (props.picked.startsWith("vault:") ? "A card no longer in the vault" : cardLabel({ ref: props.picked })) });
  }
  return (
    <div className={s.stack}>
      {list.isLoadingError ? (
        <Text size="sm" tone="danger">
          {`Couldn't list the cards: ${vaultError(list.error)}`}
        </Text>
      ) : list.data === undefined ? (
        <Text size="sm" tone="quiet">
          Reading the vault…
        </Text>
      ) : (
        <Select id="project-card" aria-label="Card" value={props.picked ?? NO_CARD} disabled={props.saving} options={[...options, { value: NO_CARD, label: "No card" }]} onValueChange={props.onPick} />
      )}
      {list.data !== undefined && cards.length === 0 ? (
        <Text size="sm" tone="quiet">
          No card in the vault this project can use yet. Add one, or import it from your 1Password.
        </Text>
      ) : null}
      <div className={s.inline}>
        <Button size="sm" variant="ghost" disabled={!live} onClick={() => setAdding("card")}>
          Add a card…
        </Button>
        <Button size="sm" variant="ghost" disabled={!live} onClick={() => setAdding("import")}>
          Import from 1Password…
        </Button>
      </div>
      {adding === "card" ? <VaultEditor whose={whose} kind="card" onClose={() => setAdding(null)} onSaved={(item) => (setAdding(null), props.onPick(`vault:${item.itemId}`))} /> : null}
      {adding === "import" ? <ImportDialog whose={whose} onClose={() => setAdding(null)} /> : null}
    </div>
  );
}
