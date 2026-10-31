// A Navi's skills, pushed from its screen: the ones it saved itself first, then the installed ones, each a row with its
// name, its description and who changed it last or when it was last used; an off one dimmed. Tapping one opens its
// view (Skill.tsx). The list reads again on skills.changed, so a skill the Navi saves shows up while it is open.
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ProjectRef } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import type { Session } from "../../session";
import { shape, space, type, useTheme, type Palette } from "../../theme";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { useNow } from "../time";
import { errorWords, Problem, Symbol, useRead } from "./parts";
import { listSkills, touchesSkills } from "./skillsApi";
import { kindOf, rowLine, skillGroups, skillKey, type Kind, type Skill } from "./skillsModel";

export function Skills({ navigation, route }: ChatInfoProps<"Skills">) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const key = route.params.key;
  const p = state.projects?.[key];
  const list = useRead(() => (p === undefined ? Promise.resolve(undefined) : listSkills(session, p)), [session, p?.machineId, p?.projectId]);
  useSkillsChanged(session, p, list.reload);
  const r = list.value;
  if (p === undefined) return <EmptyState icon="folder" title="Not Here" body="The hub doesn't list it any more." />;
  const groups = r?.ok === true ? skillGroups(r.value, p.title) : [];
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={list.reload} tintColor={t.secondary} />}
    >
      {r === undefined ? (
        <ActivityIndicator style={styles.loading} color={t.secondary} />
      ) : !r.ok ? (
        <Problem text={`Couldn't read its skills: ${errorWords(r.error)}`} />
      ) : groups.length === 0 ? (
        <EmptyState icon="sparkles" title="No Skills Yet" body={`When ${p.title} works out a task it will do again, it saves the steps as a skill. They show here, for you to read and change.`} />
      ) : (
        groups.map((g) => (
          <ListSection key={g.kind} header={g.header} {...(g.kind === "own" ? { footer: `${p.title} saves these itself and improves them as it uses them. Every change is kept.` } : {})}>
            {g.rows.map((s) => (
              <SkillRow
                key={skillKey(s)}
                icon
                skill={s}
                line={rowLine(s, now, state.meName)}
                onPress={() => {
                  haptics.tap();
                  navigation.navigate("Skill", { key, origin: s.origin, name: s.name });
                }}
              />
            ))}
          </ListSection>
        ))
      )}
    </ScrollView>
  );
}

/** Reads again on a skills.changed for this Navi, and on coming back to the screen (the first focus is the mount's read). */
export const useSkillsChanged = (session: Session, p: ProjectRef | undefined, reload: () => void): void => {
  const machineId = p?.machineId;
  const projectId = p?.projectId;
  useEffect(() => {
    if (machineId === undefined || projectId === undefined) return;
    return session.onEvent((event) => {
      if (touchesSkills(event, { machineId, projectId })) reload();
    });
  }, [session, machineId, projectId, reload]);
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) reload();
      shown.current = true;
    }, [reload]),
  );
};

/** A skill's tile: sparkles on the accent for the Navi's own, a box for an installed one, a folder for its folder's. */
export function SkillTile({ kind, size = 29 }: { kind: Kind; size?: number }) {
  const t = useTheme();
  const glyph = size * 0.58;
  return (
    <View style={[styles.tile, { width: size, height: size, borderRadius: size * 0.24, backgroundColor: tileColor(t, kind) }]}>
      {kind === "own" ? (
        <Icon name="sparkles" size={glyph} color="#FFFFFF" weight="medium" />
      ) : kind === "installed" ? (
        <Symbol ios="shippingbox.fill" android="inventory_2" size={glyph} color="#FFFFFF" weight="medium" />
      ) : (
        <Icon name="folder" size={glyph} color="#FFFFFF" weight="medium" />
      )}
    </View>
  );
}

const tileColor = (t: Palette, kind: Kind): string => (kind === "own" ? t.accentFill : kind === "installed" ? (t.tints[6] ?? t.indigo) : (t.tints[7] ?? t.secondary));

/** `icon` is ListSection's sign to inset the separator past the tile. */
function SkillRow({ skill: s, line, onPress }: { skill: Skill; line: string | undefined; icon: true; onPress: () => void }) {
  const t = useTheme();
  const off = s.off === true;
  const label = [s.name, s.description, off ? "Off" : undefined, line].filter((x) => x !== undefined && x !== "").join(", ");
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}>
      {({ pressed }) => (
        <View style={[styles.row, pressed && { backgroundColor: t.fillQuiet }]}>
          <View style={off && styles.dim}>
            <SkillTile kind={kindOf(s)} />
          </View>
          <View style={[styles.grow, off && styles.dim]}>
            <Text style={[type.body, { color: t.label }]} numberOfLines={1}>
              {s.name}
            </Text>
            {s.description === "" ? null : (
              <Text style={[type.subhead, { color: t.secondary }]} numberOfLines={1}>
                {s.description}
              </Text>
            )}
            {line === undefined ? null : (
              <Text style={[type.footnote, styles.meta, { color: t.tertiary }]} numberOfLines={1}>
                {line}
              </Text>
            )}
          </View>
          {off ? <Text style={[type.subhead, { color: t.secondary }]}>Off</Text> : null}
          <Icon name="chevron" size={14} color={t.tertiary} weight="semibold" />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: shape.row, paddingHorizontal: space.lg, paddingVertical: 10 },
  tile: { alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, gap: 1 },
  meta: { marginTop: 2 },
  dim: { opacity: 0.45 },
});
