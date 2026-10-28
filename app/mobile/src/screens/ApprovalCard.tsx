// One open approval with everything it would do, in full, and Approve and Deny. Used in the Approvals list and inline
// in a chat.
import { StyleSheet, Text, View } from "react-native";
import type { HubError, HumanRequest } from "../desktop";
import { approvalView } from "../lists";
import { color, mono, size } from "../theme";
import { Button } from "../ui";

export function ApprovalCard({
  request,
  projectTitle,
  answering,
  error,
  onAnswer,
}: {
  request: HumanRequest;
  projectTitle: string | undefined;
  answering: boolean;
  error: HubError | undefined;
  onAnswer: (decision: "approve" | "deny") => void;
}) {
  const view = approvalView(request, projectTitle);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{view.title}</Text>
      {view.fields.map((f) => (
        <View key={f.label} style={styles.field}>
          <Text style={styles.label}>{f.label}</Text>
          <Text style={[styles.value, f.mono === true && styles.mono]} selectable>
            {f.value}
          </Text>
        </View>
      ))}
      {error === undefined ? null : <Text style={styles.error}>{error.message}</Text>}
      <View style={styles.actions}>
        <Button label="Deny" tone="danger" disabled={answering} onPress={() => onAnswer("deny")} />
        <Button label={answering ? "Answering…" : "Approve"} tone="accent" disabled={answering} onPress={() => onAnswer("approve")} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 6,
    padding: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.raised,
  },
  title: { color: color.text, fontSize: size.md, fontWeight: "600" },
  field: { gap: 1 },
  label: { color: color.faint, fontSize: size.xs },
  value: { color: color.text, fontSize: size.sm, lineHeight: 18 },
  mono: { fontFamily: mono, fontSize: size.xs },
  error: { color: color.danger, fontSize: size.sm },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4 },
});
