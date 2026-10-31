// The pinned chats over the chats list, as Messages draws them: large round avatars three to a row (one to three make
// a centred row, four are three and one, nine fill three rows), each name under it. Unread, its newest message rises
// out of the avatar in a bubble, with a dot beside the name; while its lead works, a typing bubble with the working
// glyph takes the bubble's place; an approval waiting is an orange count on the avatar (pinnedGrid.ts). A tap opens
// the chat; held, the avatar lifts for the row's own actions (Mark as Read, Unpin, Mute) in iOS's menu. A pin grows
// into its place and an unpinned one shrinks away, on the app's snap curve.
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated, { withTiming, type EntryAnimationsValues, type ExitAnimationsValues } from "react-native-reanimated";
import { phaseOf } from "../desktop";
import type { ChatRow } from "../lists";
import { gridSize, pinFace } from "../pinnedGrid";
import { space, type, useTheme } from "../theme";
import { Avatar } from "../ui/Avatar";
import { HoldMenu } from "../ui/HoldMenu";
import { Icon } from "../ui/Icon";
import type { MenuItem } from "../ui/Menu";
import { dur, ease, PRESSED_OPACITY, rowMove, useReduceMotion } from "../ui/motion";
import { StateGlyph } from "../ui/StateGlyph";

/** A pin arrives: it grows out of its place as it fades in. */
const pinIn = (reduce: boolean) => (_: EntryAnimationsValues) => {
  "worklet";
  const to = (v: number) => withTiming(v, { duration: dur.enter, easing: ease.snap });
  return { initialValues: { opacity: 0, transform: [{ scale: reduce ? 1 : 0.86 }] }, animations: { opacity: to(1), transform: [{ scale: to(1) }] } };
};

/** An unpinned one shrinks away where it stood. */
const pinOut = (_: ExitAnimationsValues) => {
  "worklet";
  const to = (v: number) => withTiming(v, { duration: dur.quick, easing: ease.snap });
  return { initialValues: { opacity: 1, transform: [{ scale: 1 }] }, animations: { opacity: to(0), transform: [{ scale: to(0.86) }] } };
};

export function PinnedGrid({ rows, onOpen, menu, label }: { rows: readonly ChatRow[]; onOpen: (row: ChatRow) => void; menu: (row: ChatRow) => readonly MenuItem[]; label: (row: ChatRow) => string }) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const { cell, avatar } = gridSize(useWindowDimensions().width);
  return (
    <View style={styles.grid}>
      {rows.map((row) => {
        const face = pinFace(row);
        const bubble = face.bubble === undefined ? null : face.bubble.t === "typing" ? <Typing phase={phaseOf(row.key)} /> : <Said text={face.bubble.text} muted={row.muted} />;
        // The bubble's slot: as wide as the cell, its foot 22 pt into the avatar.
        const slot = { bottom: avatar - 22, left: -(cell - avatar) / 2 + 6, right: -(cell - avatar) / 2 + 6 };
        return (
          <Animated.View key={row.key} style={{ width: cell }} entering={pinIn(reduce)} exiting={pinOut} {...(reduce ? {} : { layout: rowMove })}>
            <HoldMenu
              items={menu(row)}
              radius={CELL_RADIUS}
              color={t.bg}
              onPress={() => onOpen(row)}
              accessibilityRole="button"
              accessibilityLabel={label(row)}
              style={({ pressed }) => (pressed ? { opacity: PRESSED_OPACITY } : null)}
            >
              <View style={styles.cell}>
                <View style={{ width: avatar, height: avatar }}>
                  <Avatar name={row.project.title} navi={row.navi} size={avatar} picture={row.project} />
                  {face.approvals > 0 ? <Approvals count={face.approvals} /> : null}
                  {bubble === null ? null : <View style={[styles.slot, slot]}>{bubble}</View>}
                </View>
                <View style={styles.name}>
                  {face.dot === undefined ? null : <View style={[styles.dot, { backgroundColor: face.dot === "muted" ? t.muted : t.accentFill }]} />}
                  {row.muted ? <Icon name="mute" size={11} color={t.tertiary} /> : null}
                  <Text style={[type.footnote, styles.nameText, face.dot === undefined ? { color: t.secondary } : [styles.nameUnread, { color: t.label }]]} numberOfLines={1}>
                    {row.project.title}
                  </Text>
                </View>
              </View>
            </HoldMenu>
          </Animated.View>
        );
      })}
    </View>
  );
}

/** Messages' typing bubble, its three dots the app's working glyph: a pill with two small rounds trailing down to the avatar. */
function Typing({ phase }: { phase: number }) {
  const t = useTheme();
  const fill = { borderColor: t.bg, backgroundColor: t.bubble };
  return (
    <View style={styles.typing} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.typingPill, fill]}>
        <View style={styles.glyph}>
          <StateGlyph state="thinking" phase={phase} />
        </View>
      </View>
      <View style={[styles.tail, fill]} />
      <View style={[styles.tailEnd, fill]} />
    </View>
  );
}

/** The newest message, risen out of the avatar in a bubble of its own. */
function Said({ text, muted }: { text: string; muted: boolean }) {
  const t = useTheme();
  return (
    <View style={[styles.said, { backgroundColor: t.bubble, borderColor: t.bg }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Text style={[type.caption, { color: muted ? t.secondary : t.label }]} numberOfLines={2}>
        {text}
      </Text>
    </View>
  );
}

/** Approvals waiting, as an app's badge on its icon. */
function Approvals({ count }: { count: number }) {
  const t = useTheme();
  return (
    <View style={[styles.badge, { backgroundColor: t.warning, borderColor: t.bg }]}>
      <Text style={[type.footnote, styles.badgeText]} allowFontScaling={false}>
        {count > 99 ? "99+" : String(count)}
      </Text>
    </View>
  );
}

/** A held avatar lifts with its name on a card with these corners. */
const CELL_RADIUS = 28;

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", paddingHorizontal: space.sm, paddingTop: 2, paddingBottom: space.md, rowGap: 2 },
  // Room over each avatar for its bubble.
  cell: { alignItems: "center", paddingTop: 26, paddingBottom: 6, gap: 7 },
  name: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%", paddingHorizontal: 6 },
  nameText: { flexShrink: 1, textAlign: "center" },
  nameUnread: { fontWeight: "600" },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
  slot: { position: "absolute", alignItems: "center" },
  said: { borderRadius: 15, borderCurve: "continuous", borderWidth: 2, paddingHorizontal: 9, paddingVertical: 5, maxWidth: "100%" },
  badge: { position: "absolute", top: -3, right: -3, minWidth: 25, height: 25, borderRadius: 12.5, borderWidth: 2.5, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#FFFFFF", fontWeight: "700", fontSize: 13, lineHeight: 16 },
  typing: { width: 60, height: 44 },
  typingPill: { position: "absolute", left: 4, top: 0, width: 56, height: 36, borderRadius: 18, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  glyph: { transform: [{ scale: 1.7 }] },
  tail: { position: "absolute", left: 2, top: 28, width: 13, height: 13, borderRadius: 6.5, borderWidth: 2 },
  tailEnd: { position: "absolute", left: -3, top: 38, width: 7, height: 7, borderRadius: 3.5, borderWidth: 1.5 },
});
