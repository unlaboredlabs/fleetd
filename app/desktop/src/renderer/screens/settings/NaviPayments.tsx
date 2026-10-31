// A Navi's Payments (its Projects page, only for a project of kind assistant; D265): the card it pays with, a Credit
// Card item from the person's own 1Password (onepassword_cards lists them; navi_card_set keeps only its op://
// reference), and every purchase it asked for (navi_purchases), with what the person said. Each purchase asks the
// person in the Navi's chat; approved, its card is filled into that checkout once, and the Navi never sees it.
import { useState } from "react";
import type { OnePasswordCardsOutput } from "../../../shared/contracts";
import { Button, InlineCode, Select, Text } from "../../ui";
import { useToolQuery } from "../../src/data/react";
import { useNow } from "../live";
import { cardLabel } from "../inline/purchase";
import { when } from "../status/view";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { NO_CARD, cardOptions, purchaseLine, purchaseState } from "./paymentsModel";
import { Setting } from "./parts";
import s from "./settings.module.css";

type Ref = { machineId: string; projectId: string };

/** Listing the cards may install the 1Password SDK on the machine first. */
const CARDS_MS = 240_000;

export function PaymentsSetting({ projectRef }: { projectRef: Ref }) {
  const live = useLive();
  const nowMs = useNow(true, 60_000);
  const hubCall = useHubCall();
  const refetch = useRefetch();
  const read = useToolQuery("navi_purchases", projectRef, { enabled: live });
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
    // On the Navi's machine, with the token its fills read the card with.
    hubCall("onepassword_cards", { navi: projectRef }, { timeoutMs: CARDS_MS }).then(
      (data) => setCards({ data }),
      (e: unknown) => setCards({ error: errorText(e) }),
    );
  };

  const pick = (value: string): void => {
    setSaving(true);
    setProblem(null);
    hubCall("navi_card_set", { ...projectRef, ...(value === NO_CARD ? {} : { card: value }) }).then(
      () => {
        setSaving(false);
        setPicking(false);
        refetch(["navi_purchases"]);
      },
      (e: unknown) => {
        setSaving(false);
        setProblem(errorText(e));
      },
    );
  };

  return (
    <Setting
      reveal="projects.payments"
      label="Payments"
      help="The card Navi pays with at a checkout, from your 1Password. Every purchase asks you first, with the shop, the total and what's in the basket; fleetd fills the card in, and Navi never sees it."
    >
      {read.isLoadingError ? (
        <Text size="sm" tone="danger">
          {errorText(read.error)}
        </Text>
      ) : read.data === undefined ? (
        <Text size="sm" tone="quiet">
          {live ? "Loading…" : "Not connected."}
        </Text>
      ) : (
        <>
          {picking ? (
            cards?.error !== undefined || cards?.data?.error !== undefined ? (
              <div role="alert" className={s.inline}>
                <Text size="sm" tone="danger">
                  {cards.error ?? `1Password: ${cards.data?.error ?? ""}`}
                </Text>
                <Button variant="secondary" disabled={!live} onClick={open}>
                  Try again
                </Button>
                <Button variant="secondary" onClick={() => setPicking(false)}>
                  Cancel
                </Button>
              </div>
            ) : cards?.data === undefined ? (
              <Text size="sm" tone="quiet">
                Reading the cards in your 1Password…
              </Text>
            ) : (
              <div className={s.inline}>
                <Select
                  id="navi-card"
                  aria-label="Card"
                  value={card?.ref ?? NO_CARD}
                  disabled={saving}
                  options={cardOptions(cards.data.cards, card?.ref)}
                  onValueChange={pick}
                />
                <Button variant="secondary" disabled={saving} onClick={() => setPicking(false)}>
                  Cancel
                </Button>
              </div>
            )
          ) : (
            <div className={s.inline}>
              <Text size="sm">{card === undefined ? "No card: Navi can't pay at a checkout." : `Pays with ${cardLabel(card)}`}</Text>
              <Button variant="secondary" disabled={!live} onClick={open}>
                {card === undefined ? "Pick a card…" : "Change…"}
              </Button>
            </div>
          )}
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
            <ul className={s.purchases} aria-label="Purchases">
              {purchases.map((p) => {
                const line = purchaseLine(p);
                return (
                  <li key={p.requestId} className={s.purchase}>
                    {/* The name is the Navi's words; the domain is where the card was filled, so the log can't be spoofed. */}
                    <Text size="sm">
                      {`${line.shop} · `}
                      <InlineCode>{p.purchase.shop.domain}</InlineCode>
                    </Text>
                    <Text size="sm" strong className={s.purchaseAmount}>
                      {line.amount}
                    </Text>
                    <Text size="xs" tone="quiet">
                      {`${purchaseState(p)} · asked ${when(p.askedAt, nowMs)}${p.answeredBy === undefined ? "" : ` · by ${p.answeredBy.replace(/^human:/u, "")}`}`}
                    </Text>
                    <Text size="xs" tone="quiet" className={s.purchaseAmount}>
                      {cardLabel(p.purchase.card)}
                    </Text>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Setting>
  );
}
