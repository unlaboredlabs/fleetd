// A project's Payments (its Projects page; D265): the card its lead pays with, a Credit Card item from the person's own
// 1Password (onepassword_cards lists them; project_card_set keeps only its op:// reference), and every purchase it
// made (project_purchases). A purchase fills the card in at its checkout without asking (D312), and the chat says what
// was paid. One section on its own, so it can go without touching the rest.
import { useState } from "react";
import type { OnePasswordCardsOutput } from "../../../shared/contracts";
import { Button, InlineCode, Select, Text } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { useNow } from "../live";
import { cardLabel, NO_CARD, cardOptions, PAYMENTS_HELP, purchaseLine, purchaseState } from "../projects/payments";
import { PROJECT_TOOLS } from "../projects/model";
import { when } from "../live/when";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { SettingsList, SettingsListRow, SettingsRow } from "./parts";
import s from "./settings.module.css";

type Ref = { machineId: string; projectId: string };

/** Listing the cards may install the 1Password SDK on the machine first. */
const CARDS_MS = 240_000;

export function PaymentsSetting({ projectRef }: { projectRef: Ref }) {
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
            : `${card === undefined ? "No card: the lead can't pay at a checkout." : `Pays with ${cardLabel(card)}.`} ${PAYMENTS_HELP}`
      }
      lineTone={read.isLoadingError ? "danger" : "quiet"}
      control={
        read.data === undefined ? undefined : picking ? (
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
          {picking && (cards?.error !== undefined || cards?.data?.error !== undefined) ? (
            <div role="alert">
              <Text size="sm" tone="danger">
                {cards.error ?? `1Password: ${cards.data?.error ?? ""}`}
              </Text>
            </div>
          ) : null}
          {picking && cards?.data !== undefined && cards.data.error === undefined && cards.data.cards.length === 0 ? (
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
            <Text size="sm" tone="quiet">
              No purchases yet.
            </Text>
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
