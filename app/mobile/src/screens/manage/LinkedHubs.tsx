// Linked Hubs, pushed from a project's screen, as the desktop's: the other hubs it reaches through hub links, each with
// the person it acts as there and the projects it is limited to, and whether it works, can't reach that hub or was
// revoked there (the desktop's words); Remove, asking first, which revokes it on the other hub too when it can. Link a
// hub takes a link key made on the other hub, sealed on the desktop, so it stays there.
import { useState } from "react";
import { ActivityIndicator, Alert, RefreshControl, ScrollView } from "react-native";
import { linkState, reachLine, type HubLink } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { refOf } from "../../store";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { readLinks, removeLink } from "./api";
import { confirmDestructive, errorWords, Problem, useRead } from "./parts";

const HELP = "Other hubs this project reaches: it opens and follows work in their projects, as the person who made the link there. Link one from this project's settings in the desktop app.";

export function LinkedHubs({ route }: ChatInfoProps<"LinkedHubs">) {
  const t = useTheme();
  const { state, session } = useHub();
  const key = route.params.key;
  const read = useRead(() => readLinks(session, refOf(key)), [session, key]);
  const [busy, setBusy] = useState<string | null>(null);
  const live = state.hub.phase === "live";

  const remove = (link: HubLink) =>
    confirmDestructive({
      title: `Remove the link to ${link.label}?`,
      message: `This project can't reach ${link.label} any more. The link is revoked there too when ${link.label} can be reached.`,
      button: "Remove",
      onConfirm: () => {
        setBusy(link.linkId);
        void removeLink(session, link.linkId).then((r) => {
          setBusy(null);
          if (!r.ok) return Alert.alert("Not removed", errorWords(r.error));
          haptics.success();
          Alert.alert(`Removed the link to ${link.label}`, r.value.revokedThere ? `Revoked on ${link.label} too.` : (r.value.next ?? undefined));
          read.reload();
        });
      },
    });

  const result = read.value;
  const links = result?.ok === true ? result.value : undefined;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      style={{ backgroundColor: t.grouped }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      <ListSection footer={links !== undefined && links.length > 0 ? `${HELP} Tap one to remove it.` : HELP}>
        {links === undefined ? (
          <ListRow title={result?.ok === false ? "Couldn't read the linked hubs" : "Reading…"} {...(result === undefined ? { accessory: <ActivityIndicator color={t.secondary} /> } : {})} />
        ) : links.length === 0 ? (
          <ListRow title="No linked hubs yet" />
        ) : (
          links.map((l) => {
            const s = linkState(l);
            const reach = reachLine(l);
            return (
              <ListRow
                key={l.linkId}
                title={l.label}
                detail={[reach, s.line, s.fix].filter((x) => x !== null).join("\n")}
                value={s.word}
                valueColor={s.tone === "danger" ? t.danger : t.secondary}
                chevron={false}
                {...(live && busy === null ? { onPress: () => remove(l) } : {})}
                {...(busy === l.linkId ? { accessory: <ActivityIndicator color={t.secondary} /> } : {})}
              />
            );
          })
        )}
      </ListSection>
      <Problem text={result?.ok === false ? errorWords(result.error) : undefined} />
    </ScrollView>
  );
}
