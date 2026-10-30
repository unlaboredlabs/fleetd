// One open approval as one calm card: who asks and what, every field that decides it in full (what runs, who it
// reaches, as whom, what it says: the card is what the person approves), context such as where a command runs behind
// Details, and Approve and Deny. Money, irreversible and secret-using asks say so in a quiet line. A character that
// hides or reorders text shows as its mark (⟨U+202E⟩), each field isolated, under a line saying so. Shown inline in
// its chat, where it is answered.
import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { listTime } from "../chatView";
import { HIDDEN_WARNING, marked, type HubError, type HumanRequest } from "../desktop";
import { exactRuns, FSI, markRuns, PDI, type Run } from "../exact";
import { approvalView, fieldCopy, type ApprovalField, type ApprovalView } from "../lists";
import { mono, space, type, useTheme } from "../theme";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { haptics } from "../ui/haptics";
import { Icon, type IconName } from "../ui/Icon";
import { useNow } from "./time";

const RISK: Record<NonNullable<ApprovalView["risk"]>, { icon: IconName; text: string }> = {
  money: { icon: "money", text: "Spends money" },
  irreversible: { icon: "irreversible", text: "Can't be undone" },
  credential: { icon: "credential", text: "Uses a secret" },
};

export function ApprovalCard({
  request,
  projectTitle,
  navi,
  answering,
  error,
  onAnswer,
}: {
  request: HumanRequest;
  projectTitle: string | undefined;
  navi: boolean;
  answering: boolean;
  error: HubError | undefined;
  onAnswer: (decision: "approve" | "deny") => void;
}) {
  const t = useTheme();
  const now = useNow();
  const [open, setOpen] = useState(false);
  const view = approvalView(request, projectTitle);
  const risk = view.risk === undefined ? undefined : RISK[view.risk];
  const shown = view.fields.filter((f) => open || f.more !== true);
  const hidden = view.fields.some((f) => f.more === true);
  return (
    <Card>
      <View style={styles.head} accessible accessibilityLabel={`${marked(view.title)}${risk === undefined ? "" : `. ${risk.text}`}`}>
        <Avatar name={view.who} navi={navi} size={40} />
        <View style={styles.who}>
          <View style={styles.whoTop}>
            <Text style={[type.headline, styles.grow, { color: t.label }]} numberOfLines={1}>
              <Exact text={view.who} />
            </Text>
            <Text style={[type.footnote, { color: t.secondary }]}>{listTime(request.createdAt, now)}</Text>
          </View>
          <Text style={[type.subhead, { color: t.secondary }]}>
            <Exact text={view.wants} />
          </Text>
        </View>
      </View>
      {risk === undefined ? null : (
        <View style={[styles.risk, { backgroundColor: t.warningSoft }]}>
          <Icon name={risk.icon} size={14} color={t.warning} weight="semibold" />
          <Text style={[type.footnote, styles.riskText, { color: t.warning }]}>{risk.text}</Text>
        </View>
      )}
      {!view.hidden ? null : (
        <View style={[styles.risk, { backgroundColor: t.warningSoft }]}>
          <Icon name="hidden" size={14} color={t.warning} weight="semibold" />
          <Text style={[type.footnote, styles.riskText, { color: t.warning }]}>{HIDDEN_WARNING}</Text>
        </View>
      )}
      {shown.length === 0 ? null : (
        <View style={styles.fields}>
          {shown.map((f) => (
            <Field key={f.label} field={f} />
          ))}
        </View>
      )}
      {!hidden ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => {
            haptics.select();
            setOpen(!open);
          }}
          hitSlop={10}
          style={styles.details}
        >
          <Text style={[type.subhead, { color: t.accent }]}>{open ? "Less" : "Details"}</Text>
          <Icon name="chevronDown" size={12} color={t.accent} weight="semibold" style={open ? styles.flip : undefined} />
        </Pressable>
      )}
      {error === undefined ? null : (
        <Text style={[type.footnote, { color: t.danger }]} accessibilityLiveRegion="polite">
          {error.message}
        </Text>
      )}
      <View style={styles.actions}>
        <Button
          label="Deny"
          kind="tinted"
          destructive
          size="large"
          grow
          disabled={answering}
          onPress={() => {
            haptics.firm();
            onAnswer("deny");
          }}
        />
        <Button
          label="Approve"
          size="large"
          grow
          busy={answering}
          onPress={() => {
            haptics.success();
            onAnswer("approve");
          }}
        />
      </View>
    </Card>
  );
}

/**
 * One field: its label, then its value as drawn. The drawn text holds marks and isolates, so it isn't selectable; a
 * long press copies the exact text instead (fieldCopy), as the desktop's Copy does.
 */
function Field({ field: f }: { field: ApprovalField }) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    void Clipboard.setStringAsync(fieldCopy(f));
    haptics.success();
    setCopied(true);
  };
  return (
    <Pressable style={styles.field} onLongPress={copy} delayLongPress={300} accessibilityHint="Touch and hold to copy it exactly">
      <Text style={[type.footnote, { color: t.secondary }]}>{copied ? `${f.label} · Copied` : f.label}</Text>
      <Text style={[f.mono === true ? styles.mono : type.subhead, { color: t.label }]}>
        <Value field={f} />
      </Text>
    </Pressable>
  );
}

/**
 * A field's value, exactly: a command word by word, each its own left-to-right isolate so a right-to-left word can't
 * swap the order its neighbours read in; machine text left to right; the asker's words and a body as their own words
 * decide.
 */
function Value({ field: f }: { field: ApprovalField }) {
  if (f.words !== undefined) {
    return f.words.map((w, i) => (
      <Text key={i}>
        {i === 0 ? null : " "}
        <Exact text={w} ltr />
      </Text>
    ));
  }
  if (f.prose === true) return <WithCode text={f.value} />;
  return <Exact text={f.value} lines={f.lines === true} ltr={f.mono === true || f.lines !== true} />;
}

/** `text` in its own isolate, each hidden character as its mark. Inside a <Text>. */
function Exact({ text, lines = false, ltr = false }: { text: string; lines?: boolean; ltr?: boolean }) {
  return <Runs runs={exactRuns(text, { lines, ltr })} />;
}

/** The asker's own words (why) with their `code` spans drawn in monospace. Never for what goes out: that shows as is. */
function WithCode({ text }: { text: string }) {
  // The whole in one isolate, as Exact's, with each part's marks inside it.
  const parts = text.split(/(`[^`\n]+`)/u);
  return (
    <>
      {FSI}
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <Text key={i} style={styles.inlineCode}>
            <Runs runs={markRuns(p.slice(1, -1))} />
          </Text>
        ) : (
          <Runs key={i} runs={markRuns(p, true)} />
        ),
      )}
      {PDI}
    </>
  );
}

function Runs({ runs }: { runs: readonly Run[] }) {
  const t = useTheme();
  return runs.map((r, i) =>
    r.mark ? (
      <Text key={i} style={[styles.mark, { color: t.warning, backgroundColor: t.warningSoft }]}>
        {r.text}
      </Text>
    ) : (
      r.text
    ),
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: space.md },
  who: { flex: 1, gap: 1 },
  whoTop: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  grow: { flex: 1 },
  risk: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 5, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8 },
  riskText: { fontWeight: "600" },
  fields: { gap: space.md },
  field: { gap: 2 },
  mono: { fontFamily: mono, fontSize: 14, lineHeight: 19 },
  inlineCode: { fontFamily: mono, fontSize: 14 },
  mark: { fontFamily: mono, fontSize: 12, fontWeight: "600" },
  details: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: 28 },
  flip: { transform: [{ rotate: "180deg" }] },
  actions: { flexDirection: "row", gap: space.md, marginTop: space.xs },
});
