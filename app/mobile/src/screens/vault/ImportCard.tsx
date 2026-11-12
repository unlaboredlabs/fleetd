// A lead's proposal to bring items from the person's 1Password into the vault, as a card in its chat (a system
// message's `vaultImport`, vault-design §6): why it asks, each item with its kind and site, ticked, a tap unticking it,
// and Import and Dismiss. They go where the proposal says: logins, cards and addresses to the team vault, variables to
// the project or the order. Import is the one confirm the vault has: the items are read on a
// machine holding the person's token and sealed to the hub there, so no value reaches the phone, the chat or the lead.
// Once answered, one quiet line says how it went.
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSession } from "../../hubContext";
import { space, type, useTheme } from "../../theme";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { errorWords } from "../manage/parts";
import { dismissImport, importItems, vaultErrorWords, vaultHub } from "./api";
import { importOutcome, KIND_WORDS, knownKind } from "./model";
import { KindTile } from "./parts";
import type { VaultImportCard } from "./types";

export function ImportCard({ card }: { card: VaultImportCard }) {
  const t = useTheme();
  const session = useSession();
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<"import" | "dismiss" | null>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // The hub's answer arrives as the message's new state; until then the card says what was asked.
  const [answered, setAnswered] = useState<string | undefined>(undefined);
  const outcome = card.state === "open" ? answered : importOutcome(card);

  if (outcome !== undefined) {
    return (
      <View style={styles.outcome} accessible accessibilityLabel={outcome}>
        <Icon name={card.state === "dismissed" ? "denied" : "check"} size={13} color={card.state === "dismissed" ? t.secondary : t.success} />
        <Text style={[type.footnote, styles.outcomeText, { color: t.secondary }]}>{outcome}</Text>
      </View>
    );
  }

  // An item of a kind this app doesn't know is still imported: only its row here is plainer.
  const ticked = card.items.filter((i) => !unticked.has(i.ref));
  const toggle = (ref: string) => {
    haptics.select();
    setUnticked((u) => {
      const next = new Set(u);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  };
  const run = async (what: "import" | "dismiss") => {
    haptics.tap();
    setBusy(what);
    setProblem(undefined);
    const hub = vaultHub(session);
    const r = what === "dismiss" ? await dismissImport(hub, card.proposalId) : await importItems(hub, { proposalId: card.proposalId, refs: ticked.map((i) => i.ref) });
    setBusy(null);
    if (!r.ok) {
      haptics.warning();
      return setProblem(vaultErrorWords(r.error) ?? errorWords(r.error));
    }
    if (what === "dismiss") {
      haptics.firm();
      return setAnswered("Not imported");
    }
    const got = r.value as { items: readonly unknown[]; errors: ReadonlyArray<{ ref: string; message: string }> };
    haptics.success();
    setAnswered(importOutcome({ state: "imported", imported: got.items.length }));
    if (got.errors.length > 0) setProblem(got.errors.map((e) => `${card.items.find((i) => i.ref === e.ref)?.title ?? e.ref}: ${e.message}`).join("\n"));
  };

  return (
    <Card>
      <View style={styles.head}>
        <Icon name="import" size={22} color={t.accent} />
        <Text style={[type.headline, styles.grow, { color: t.label }]}>Import from 1Password</Text>
      </View>
      {card.why.trim() === "" ? null : <Text style={[type.subhead, { color: t.label }]}>{card.why}</Text>}
      <View style={[styles.items, { backgroundColor: t.cell }]}>
        {card.items.map((i, n) => {
          const on = !unticked.has(i.ref);
          const kind = knownKind(i.kind) ? i.kind : undefined;
          const line = [kind === undefined ? undefined : KIND_WORDS[kind].one, i.site].filter((x) => x !== undefined && x !== "").join(" · ");
          return (
            <Pressable
              key={i.ref}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled: busy !== null }}
              accessibilityLabel={`${i.title}, ${line}`}
              disabled={busy !== null}
              onPress={() => toggle(i.ref)}
              style={({ pressed }) => [styles.item, n > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.separator }, pressed && { backgroundColor: t.fillQuiet }]}
            >
              {kind === undefined ? <Icon name="import" size={22} color={t.secondary} /> : <KindTile kind={kind} size={26} />}
              <View style={styles.grow}>
                <Text style={[type.body, { color: t.label }]} numberOfLines={1}>
                  {i.title}
                </Text>
                <Text style={[type.footnote, { color: t.secondary }]} numberOfLines={1}>
                  {line}
                </Text>
              </View>
              <Icon name={on ? "check" : "unchecked"} size={22} color={on ? t.accent : t.tertiary} />
            </Pressable>
          );
        })}
      </View>
      <Text style={[type.footnote, { color: t.secondary }]}>Read on your machine and sealed there. The lead never sees a value.</Text>
      {problem === undefined ? null : (
        <Text style={[type.footnote, { color: t.danger }]} accessibilityRole="alert">
          {problem}
        </Text>
      )}
      <View style={styles.actions}>
        <Button label="Dismiss" kind="tinted" size="large" grow disabled={busy !== null} busy={busy === "dismiss"} onPress={() => void run("dismiss")} />
        <Button label={ticked.length === card.items.length ? "Import" : `Import ${String(ticked.length)}`} size="large" grow disabled={ticked.length === 0 || busy !== null} busy={busy === "import"} onPress={() => void run("import")} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: space.md },
  grow: { flex: 1, gap: 1 },
  items: { borderRadius: 14, borderCurve: "continuous", overflow: "hidden" },
  item: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, paddingVertical: 9 },
  actions: { flexDirection: "row", gap: space.md, marginTop: space.xs },
  outcome: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, marginVertical: space.sm, paddingHorizontal: space.xl },
  outcomeText: { flexShrink: 1 },
});
