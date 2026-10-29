// One open approval as one calm card: who asks and what, every field that decides it in full (what runs, who it
// reaches, as whom, what it says: the card is what the person approves), context such as where a command runs behind
// Details, and Approve and Deny. Money, irreversible and secret-using asks say so in a quiet line. Used in the
// Approvals list and inline in a chat.
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { listTime } from "../chatView";
import type { HubError, HumanRequest } from "../desktop";
import { approvalView, type ApprovalView } from "../lists";
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
  on = "plain",
}: {
  request: HumanRequest;
  projectTitle: string | undefined;
  navi: boolean;
  answering: boolean;
  error: HubError | undefined;
  onAnswer: (decision: "approve" | "deny") => void;
  on?: "plain" | "grouped";
}) {
  const t = useTheme();
  const now = useNow();
  const [open, setOpen] = useState(false);
  const view = approvalView(request, projectTitle);
  const risk = view.risk === undefined ? undefined : RISK[view.risk];
  const shown = view.fields.filter((f) => open || f.more !== true);
  const hidden = view.fields.some((f) => f.more === true);
  return (
    <Card on={on}>
      <View style={styles.head} accessible accessibilityLabel={`${view.title}${risk === undefined ? "" : `. ${risk.text}`}`}>
        <Avatar name={view.who} navi={navi} size={40} />
        <View style={styles.who}>
          <View style={styles.whoTop}>
            <Text style={[type.headline, styles.grow, { color: t.label }]} numberOfLines={1}>
              {view.who}
            </Text>
            <Text style={[type.footnote, { color: t.secondary }]}>{listTime(request.createdAt, now)}</Text>
          </View>
          <Text style={[type.subhead, { color: t.secondary }]}>{view.wants}</Text>
        </View>
      </View>
      {risk === undefined ? null : (
        <View style={[styles.risk, { backgroundColor: t.warningSoft }]}>
          <Icon name={risk.icon} size={14} color={t.warning} weight="semibold" />
          <Text style={[type.footnote, styles.riskText, { color: t.warning }]}>{risk.text}</Text>
        </View>
      )}
      {shown.length === 0 ? null : (
        <View style={styles.fields}>
          {shown.map((f) => (
            <View key={f.label} style={styles.field}>
              <Text style={[type.footnote, { color: t.secondary }]}>{f.label}</Text>
              <Text style={[f.mono === true ? styles.mono : type.subhead, { color: t.label }]} selectable>
                {f.prose === true ? <WithCode text={f.value} /> : f.value}
              </Text>
            </View>
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

/** The asker's own words (why) with their `code` spans drawn in monospace. Never for what goes out: that shows as is. */
function WithCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/u);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <Text key={i} style={styles.inlineCode}>
            {p.slice(1, -1)}
          </Text>
        ) : (
          p
        ),
      )}
    </>
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
  details: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: 28 },
  flip: { transform: [{ rotate: "180deg" }] },
  actions: { flexDirection: "row", gap: space.md, marginTop: space.xs },
});
