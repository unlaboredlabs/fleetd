// Settings' Update section (updates.ts): the one status the desktop app shows, in the same words. Its title, one quiet
// line and its one button, which starts at once: Update, or Try again or Start over after one that didn't go through.
// A machine gets a row only when it didn't update or is behind. It is where the chats list's word for the hub leads
// (hubWord.ts): after an update everyone, members too, reads how it ended, without a button.
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { clockAt, serves, startUpdate, useAuto, useFlow, useReady, useRun, type Status } from "../desktop";
import { useHub } from "../hubContext";
import { space, useTheme } from "../theme";
import { useAnnounce } from "../ui/announce";
import { Button } from "../ui/Button";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { updateSection } from "../updates";

/** The hub's own words carry `code` marks, which a row has no way to show. */
const plain = (text: string | undefined): string | undefined => text?.replace(/`/gu, "");

/** The section's status as it is now (null where it shows none). */
export function useUpdateStatus(): Status | null {
  const { state } = useHub();
  const flow = useFlow();
  const run = useRun();
  const ready = useReady();
  const auto = useAuto();
  return updateSection({ admin: state.admin, hub: state.hub, machines: state.machines, run, flow, ready, auto, restart: state.restart, update: state.hubUpdate, updates: serves(state, "hub_update") });
}

/** Only "Up to date", nothing to do and nothing to say: Settings' Version row says it, with no section of its own. */
export const merelyCurrent = (status: Status | null): boolean => status !== null && status.kind === "current" && status.updatedAt === undefined && status.detail === undefined && status.action === undefined && status.rows.length === 0;

/** `inVersion`: Settings' Version row shows, and says "Up to date" itself. */
export function UpdateFleetd({ inVersion = false }: { inVersion?: boolean }) {
  const t = useTheme();
  const { session } = useHub();
  const status = useUpdateStatus();
  // An update as it goes and how it ended; what merely stands (up to date, one to take) is read, not announced.
  useAnnounce(status !== null && (status.kind === "updating" || status.kind === "failed" || status.updatedAt !== undefined) ? status.title : undefined);
  if (status === null || (inVersion && merelyCurrent(status))) return null;

  const action = status.action;
  const go = () => {
    haptics.firm();
    void startUpdate(session.updates, action?.act === "startOver");
  };
  const dot = <View style={[styles.dot, { backgroundColor: t.danger }]} />;
  return (
    <ListSection header="Update">
      <ListRow
        title={status.title}
        detail={plain(status.detail)}
        {...(status.updatedAt === undefined ? {} : { value: clockAt(status.updatedAt) })}
        accessory={
          status.kind === "updating" ? (
            <ActivityIndicator size="small" color={t.secondary} />
          ) : status.kind === "failed" || action !== undefined ? (
            <View style={styles.end}>
              {status.kind === "failed" ? dot : null}
              {action === undefined ? null : <Button label={action.label} kind={status.kind === "available" && status.quiet !== true ? "filled" : "tinted"} size="small" onPress={go} />}
            </View>
          ) : undefined
        }
      />
      {status.rows.map((row) => (
        <ListRow key={row.key} title={row.name} detail={plain(row.why)} accessory={row.tone === "danger" ? dot : undefined} />
      ))}
    </ListSection>
  );
}

const styles = StyleSheet.create({
  end: { flexDirection: "row", alignItems: "center", gap: space.md },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
});
