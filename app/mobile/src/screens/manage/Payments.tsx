// Payments, pushed from a project's screen, as the desktop's Settings › Projects › Payments: the card it pays with, and
// every purchase it made, with what became of it. On a hub with a vault the card is one of the vault's its work can use
// (its own, the person's, the hub's: vault_list), kept as `vault:<id>`, with Add Card and Import from 1Password beside
// them; on an older hub, a Credit Card item from the person's own 1Password (onepassword_cards lists them, on its
// machine; the project's card tool keeps only its op:// reference). The card is filled into a checkout without asking
// (D312), and the project never sees it. Its calls are its own, here, so Payments stays one piece.
import { useFocusEffect, useNavigation, type NavigationProp } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView } from "react-native";
import { listTime } from "../../chatView";
import { cardLabel, cardOptions, NO_CARD, PAYMENTS_HELP, PROJECT_TOOLS, purchaseLine, purchaseState, type HubError, type OnePasswordCardsOutput, type ProjectRef, type PurchasesOutput } from "../../desktop";
import { useHub, type ChatInfoProps, type VaultParams } from "../../hubContext";
import { refOf } from "../../store";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { useNow } from "../time";
import type { Hub, Result } from "./api";
import { CheckRow, errorWords, Problem, useRead } from "./parts";
import { usableCards, vaultHub } from "../vault/api";
import { rowLine, vaultShown } from "../vault/model";
import type { VaultItemSummary } from "../vault/types";

/** Listing the cards may install the 1Password SDK on the machine first. */
const CARDS_MS = 240_000;

const ref = (p: ProjectRef): ProjectRef => ({ machineId: p.machineId, projectId: p.projectId });

const readPurchases = async (hub: Hub, p: ProjectRef): Promise<Result<PurchasesOutput>> => {
  const r = await hub.call(PROJECT_TOOLS.purchases, ref(p));
  return r.ok ? { ok: true, value: r.output } : r;
};

/** The Credit Card items its machine's 1Password token reads, with the token it fills from. */
const readCards = async (hub: Hub, p: ProjectRef): Promise<Result<OnePasswordCardsOutput>> => {
  const r = await hub.call("onepassword_cards", { navi: ref(p) }, CARDS_MS);
  return r.ok ? { ok: true, value: r.output } : r;
};

/** A card picked by its op:// reference, or none. */
const setCard = async (hub: Hub, p: ProjectRef, card: string | undefined): Promise<Result<null>> => {
  const r = await hub.call(PROJECT_TOOLS.cardSet, { ...ref(p), ...(card === undefined ? {} : { card }) });
  return r.ok ? { ok: true, value: null } : r;
};

/** Payments' help on a hub with a vault: the card comes from there. */
const VAULT_HELP =
  "The card it pays with at a checkout, from the vault. fleetd fills it in at the checkout, and the project never sees it. Use a virtual or low-limit card, never your main one. Each purchase is listed below, with the shop and the total.";

export function Payments({ route }: ChatInfoProps<"Payments">) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const key = route.params.key;
  const p = refOf(key);
  const read = useRead(() => readPurchases(session, p), [session, key]);
  // The cards are read when the person asks to change the card, and only then: listing them may take minutes.
  const [cards, setCards] = useState<Result<OnePasswordCardsOutput> | "reading" | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const live = state.hub.phase === "live";
  const view = read.value?.ok === true ? read.value.value : undefined;
  const card = view?.card?.ref;
  const vault = vaultShown(state.hub);
  const navigation = useNavigation<NavigationProp<VaultParams>>();
  // The vault's cards, read when the person asks to change the card: a quick read, no 1Password.
  const [vaultCards, setVaultCards] = useState<Result<readonly VaultItemSummary[]> | "reading" | null>(null);

  // Back from Add Card or an import, the list reads again with what was added.
  const listed = useRef(false);
  listed.current = vaultCards !== null && vaultCards !== "reading" && vaultCards.ok;
  useFocusEffect(
    useCallback(() => {
      if (listed.current) void usableCards(vaultHub(session), p).then(setVaultCards);
    }, [session, key]),
  );

  const change = () => {
    haptics.tap();
    if (vault) {
      setVaultCards("reading");
      void usableCards(vaultHub(session), p).then(setVaultCards);
      return;
    }
    setCards("reading");
    void readCards(session, p).then(setCards);
  };

  const pick = async (value: string) => {
    if (saving !== null) return;
    haptics.select();
    setSaving(value);
    setError(null);
    const r = await setCard(session, p, value === NO_CARD ? undefined : value);
    setSaving(null);
    if (!r.ok) return setError(r.error);
    setCards(null);
    setVaultCards(null);
    read.reload();
  };

  // A card list that failed (the hub's error, or 1Password's) is no answer: the Card row asks again, and pulling to
  // refresh puts it away with the read.
  const cardsFailed = cards !== null && cards !== "reading" && (!cards.ok || cards.value.error !== undefined);
  const refresh = () => {
    if (cardsFailed) setCards(null);
    if (vaultCards !== null && vaultCards !== "reading" && !vaultCards.ok) setVaultCards(null);
    read.reload();
  };

  const spinner = <ActivityIndicator color={t.secondary} />;
  const options = cards !== null && cards !== "reading" && cards.ok ? cardOptions(cards.value.cards, card) : undefined;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      style={{ backgroundColor: t.grouped }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={t.secondary} />}
    >
      <ListSection footer={vault ? VAULT_HELP : PAYMENTS_HELP}>
        {view === undefined ? (
          <ListRow title={read.value?.ok === false ? "Couldn't read its payments" : "Reading…"} {...(read.value === undefined ? { accessory: spinner } : {})} />
        ) : (
          <ListRow
            title="Card"
            value={card === undefined ? "None" : (view?.card as { label?: string } | undefined)?.label ?? cardLabel({ ref: card })}
            {...(live && (vault ? vaultCards === null || (vaultCards !== "reading" && !vaultCards.ok) : cards === null || cardsFailed) ? { onPress: change } : {})}
          />
        )}
      </ListSection>
      <Problem text={read.value?.ok === false ? errorWords(read.value.error) : undefined} />

      {vaultCards === "reading" ? (
        <ListSection header="Cards">
          <ListRow title="Reading…" accessory={spinner} />
        </ListSection>
      ) : vaultCards !== null && !vaultCards.ok ? (
        <Problem text={`Couldn't list the cards: ${errorWords(vaultCards.error)}`} />
      ) : vaultCards !== null ? (
        <ListSection header="Cards" footer="Cards in the vault this project can use: its own, yours, and the hub's.">
          {[...vaultCards.value.map((c) => ({ value: `vault:${c.itemId}`, title: c.label, detail: rowLine(c) })), { value: NO_CARD, title: "No card", detail: undefined }].map((o) => (
            <CheckRow key={o.value} title={o.title} detail={o.detail} checked={o.value === (card ?? NO_CARD)} disabled={!live || saving !== null} onPress={() => void pick(o.value)} />
          ))}
          <ListRow title="Add Card…" onPress={() => navigation.navigate("VaultEdit", { kind: "card", key })} chevron={false} />
          <ListRow title="Import from 1Password…" onPress={() => navigation.navigate("VaultImport", { key })} chevron={false} />
        </ListSection>
      ) : null}
      {cards === "reading" ? (
        <ListSection header="Your cards" footer="Reading your 1Password. The first time on a machine, this can take a few minutes.">
          <ListRow title="Reading…" accessory={spinner} />
        </ListSection>
      ) : cards !== null && !cards.ok ? (
        <Problem text={`Couldn't list your cards: ${errorWords(cards.error)}`} />
      ) : cards !== null && cards.value.error !== undefined ? (
        <Problem text={cards.value.error} />
      ) : options === undefined ? null : (
        <ListSection header="Your cards">
          {options.map((o) => (
            <CheckRow key={o.value} title={o.label} checked={o.value === (card ?? NO_CARD)} disabled={!live || saving !== null} onPress={() => void pick(o.value)} />
          ))}
        </ListSection>
      )}
      <Problem text={error === null ? undefined : `Not changed: ${errorWords(error)}`} />

      {view === undefined ? null : (
        <ListSection header="Purchases">
          {view.purchases.length === 0 ? (
            <ListRow title="Nothing bought yet" />
          ) : (
            view.purchases.map((e) => {
              const line = purchaseLine(e);
              return <ListRow key={e.requestId} title={line.shop} detail={`${listTime(e.askedAt, now)} · ${purchaseState(e)}`} value={line.amount} />;
            })
          )}
        </ListSection>
      )}
    </ScrollView>
  );
}
