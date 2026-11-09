// The person's sections in the chats list (sections.ts): each one's quiet label, which folds it at a tap and holds its
// own menu (Rename…, Move Up, Move Down, Remove Section), and Move to Section… in a chat's hold menu, which asks where
// in iOS's action sheet: each section with a ✓ on the chat's own, No Section, and New Section…, named in iOS's own
// prompt. Android has neither, so it asks in the app's drawn menu and a small prompt of its own. A change shows at once
// and goes to the hub (Session.setSections); a name the hub would refuse never leaves the prompt.
import { useRef, useState } from "react";
import { AccessibilityInfo, ActionSheetIOS, Alert, Modal, Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import type { ChatRow } from "../lists";
import { dispatchPrefs } from "../prefsStore";
import {
  addSection,
  labelActions,
  labelWords,
  moveChat,
  moveSection,
  nameProblem,
  newSectionId,
  removeSection,
  renameSection,
  roomForSection,
  sectionChoices,
  SECTIONS_MAX,
  type LabelAction,
  type Section,
  type SectionChoice,
  type SectionLine,
} from "../sections";
import type { Session } from "../session";
import { space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { HoldMenu } from "../ui/HoldMenu";
import { Icon, type IconName } from "../ui/Icon";
import { Menu, type MenuItem, type Rect } from "../ui/Menu";

/** A name being asked for: a new section's, or a rename (`except`: the section renamed, whose own name is no clash). */
interface Naming {
  readonly title: string;
  readonly message?: string;
  readonly value: string;
  readonly button: string;
  readonly except?: string;
  readonly onName: (name: string) => void;
}

const LABEL_ITEMS: Record<LabelAction, { readonly label: string; readonly icon: IconName; readonly presents?: true; readonly destructive?: true }> = {
  rename: { label: "Rename…", icon: "edit", presents: true },
  up: { label: "Move Up", icon: "moveUp" },
  down: { label: "Move Down", icon: "moveDown" },
  remove: { label: "Remove Section", icon: "noSection", destructive: true },
};

/**
 * The list's ways to change the sections (`sections`: this hub's, as the phone has them now). `moveItem` is a chat's
 * Move to Section…; `labelItems` a held label's menu (`shown`: the sections on show, in order); `asking` is what
 * Android draws to ask, for the screen to render.
 */
export function useSectionMenus(session: Session, sections: readonly Section[]) {
  // What a prompt answers to is the list as it is then, not as it was when the menu opened.
  const latest = useRef(sections);
  latest.current = sections;
  const screen = useWindowDimensions();
  const [picking, setPicking] = useState<ChatRow | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null);

  const save = (next: readonly Section[]) => {
    if (next === latest.current) return;
    haptics.select();
    void session.setSections(next);
  };

  const askName = (o: Naming) => {
    if (Platform.OS !== "ios") return setNaming(o);
    Alert.prompt(
      o.title,
      o.message,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: o.button,
          onPress: (typed?: string) => {
            const name = typed ?? "";
            const problem = nameProblem(latest.current, name, o.except);
            if (problem === undefined) return o.onName(name);
            // Said, then asked again with what was typed.
            haptics.warning();
            Alert.alert(problem, undefined, [{ text: "OK", onPress: () => askName({ ...o, value: name }) }]);
          },
        },
      ],
      "plain-text",
      o.value,
    );
  };

  const newSection = (row: ChatRow) => {
    if (!roomForSection(latest.current, row.key)) {
      haptics.warning();
      return Alert.alert(`You can have up to ${String(SECTIONS_MAX)} sections`, "Remove one to make another.");
    }
    askName({ title: "New Section", message: `A name for a section with ${row.project.title} in it.`, value: "", button: "Create", onName: (name) => save(addSection(latest.current, newSectionId(), name, row.key)) });
  };

  const choose = (row: ChatRow, to: SectionChoice["to"]) => {
    if (to.t === "new") return newSection(row);
    save(moveChat(latest.current, row.key, to.t === "none" ? null : to.id));
  };

  const move = (row: ChatRow) => {
    // No sections yet: the only place to move it is a new one.
    if (latest.current.length === 0) return newSection(row);
    if (Platform.OS !== "ios") return setPicking(row);
    const choices = sectionChoices(latest.current, row.key);
    ActionSheetIOS.showActionSheetWithOptions({ title: `Move ${row.project.title} to`, options: [...choices.map((c) => (c.ticked ? `✓ ${c.label}` : c.label)), "Cancel"], cancelButtonIndex: choices.length }, (i) => {
      const choice = choices[i];
      if (choice !== undefined) choose(row, choice.to);
    });
  };

  const moveItem = (row: ChatRow): MenuItem => ({ label: "Move to Section…", icon: "folder", presents: true, onPress: () => move(row) });

  const act = (section: Section, action: LabelAction, shown: readonly string[]) => {
    if (action === "rename") return askName({ title: "Rename Section", value: section.name, button: "Rename", except: section.id, onName: (name) => save(renameSection(latest.current, section.id, name)) });
    if (action === "remove") {
      // Folded is this phone's note about a section that is no more.
      dispatchPrefs({ t: "fold", id: section.id, on: false });
      return save(removeSection(latest.current, section.id));
    }
    save(moveSection(latest.current, section.id, action === "up" ? -1 : 1, shown));
  };

  const labelItems = (section: Section, shown: readonly string[]): readonly MenuItem[] => labelActions(section.id, shown).map((a) => ({ ...LABEL_ITEMS[a], onPress: () => act(section, a, shown) }));

  // Android's: the drawn menu in the middle of the screen, and the prompt.
  const at: Rect = { x: (screen.width - MENU_WIDTH) / 2, y: screen.height / 4, width: MENU_WIDTH, height: 0 };
  const asking = (
    <>
      <Menu
        at={picking === null ? null : at}
        title={picking === null ? undefined : `Move ${picking.project.title} to`}
        items={picking === null ? [] : sectionChoices(sections, picking.key).map((c) => ({ label: c.label, icon: c.ticked ? "done" : c.to.t === "new" ? "plus" : c.to.t === "none" ? "noSection" : "folder", presents: c.to.t === "new", onPress: () => choose(picking, c.to) }))}
        onClose={() => setPicking(null)}
      />
      {naming === null ? null : <NamePrompt key={naming.title + naming.value} ask={naming} problemOf={(name) => nameProblem(latest.current, name, naming.except)} onClose={() => setNaming(null)} />}
    </>
  );

  return { moveItem, labelItems, asking };
}

/** ui/Menu.tsx's width: the drawn menu stands in the middle of the screen. */
const MENU_WIDTH = 250;

/** Android's stand-in for iOS's prompt: a card with one field, which says why a name won't do under it. */
function NamePrompt({ ask, problemOf, onClose }: { ask: Naming; problemOf: (name: string) => string | undefined; onClose: () => void }) {
  const t = useTheme();
  const [typed, setTyped] = useState(ask.value);
  const [problem, setProblem] = useState<string>();
  const done = () => {
    const said = problemOf(typed);
    if (said !== undefined) {
      haptics.warning();
      AccessibilityInfo.announceForAccessibility(said);
      return setProblem(said);
    }
    onClose();
    ask.onName(typed);
  };
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[StyleSheet.absoluteFill, styles.dim]} onPress={onClose} accessibilityRole="button" accessibilityLabel="Cancel" />
      <View style={styles.promptAt} pointerEvents="box-none">
        <View style={[styles.prompt, { backgroundColor: t.cell }]} accessibilityViewIsModal>
          <Text style={[type.headline, { color: t.label }]}>{ask.title}</Text>
          {ask.message === undefined ? null : <Text style={[type.footnote, { color: t.secondary }]}>{ask.message}</Text>}
          <TextInput
            value={typed}
            onChangeText={(text) => {
              setTyped(text);
              setProblem(undefined);
            }}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={done}
            accessibilityLabel="Name"
            placeholder="Name"
            placeholderTextColor={t.tertiary}
            selectionColor={t.accent}
            style={[type.body, styles.field, { color: t.label, backgroundColor: t.fillQuiet }]}
          />
          {problem === undefined ? null : <Text style={[type.footnote, { color: t.danger }]}>{problem}</Text>}
          <View style={styles.promptButtons}>
            <Pressable onPress={onClose} accessibilityRole="button" hitSlop={8}>
              <Text style={[type.body, { color: t.secondary }]}>Cancel</Text>
            </Pressable>
            <Pressable onPress={done} accessibilityRole="button" hitSlop={8}>
              <Text style={[type.body, styles.promptDone, { color: t.accent }]}>{ask.button}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * A section's label over its chats: quiet, in line with the avatars, with no line and no count. A tap folds the section
 * to this one line, which then says how many chats it holds, with a dot when one of them needs you or is unread, and a
 * chevron; held, its menu. VoiceOver reads it as a header that says folded or open.
 */
export function SectionLabel({ line, items }: { line: Extract<SectionLine, { t: "section" }>; items: readonly MenuItem[] }) {
  const t = useTheme();
  return (
    <HoldMenu
      items={items}
      radius={LABEL_RADIUS}
      color={t.bg}
      onPress={() => {
        haptics.select();
        dispatchPrefs({ t: "fold", id: line.section.id, on: !line.folded });
      }}
      accessibilityRole="header"
      accessibilityLabel={labelWords(line)}
      accessibilityHint={line.folded ? "Opens the section" : "Folds the section"}
      style={({ pressed }) => (pressed ? { backgroundColor: t.fillQuiet } : null)}
    >
      <View style={styles.label}>
        <Text style={[type.subhead, styles.labelName, { color: t.secondary }]} numberOfLines={1}>
          {line.section.name}
        </Text>
        {line.folded ? (
          <View style={styles.labelEnd}>
            {line.dot ? <View style={[styles.labelDot, { backgroundColor: t.accentFill }]} /> : null}
            <Text style={[type.subhead, { color: t.secondary }]}>{line.count}</Text>
            <Icon name="chevron" size={12} color={t.tertiary} weight="semibold" />
          </View>
        ) : null}
      </View>
    </HoldMenu>
  );
}

/** A held label lifts as a card with these corners. */
const LABEL_RADIUS = 12;

const styles = StyleSheet.create({
  // As tall as a finger needs (44 pt), its name nearer its own chats than those above.
  label: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, minHeight: 44, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: 6 },
  labelName: { flex: 1 },
  labelEnd: { flexDirection: "row", alignItems: "center", gap: 6 },
  labelDot: { width: 8, height: 8, borderRadius: 4 },
  dim: { backgroundColor: "rgba(0,0,0,0.4)" },
  promptAt: { flex: 1, alignItems: "center", paddingTop: "30%", paddingHorizontal: space.xl },
  prompt: { alignSelf: "stretch", borderRadius: 22, borderCurve: "continuous", padding: space.lg, gap: space.sm },
  field: { borderRadius: 10, borderCurve: "continuous", paddingHorizontal: space.md, paddingVertical: 10, marginTop: space.xs },
  promptButtons: { flexDirection: "row", justifyContent: "flex-end", gap: space.xl, marginTop: space.sm },
  promptDone: { fontWeight: "600" },
});
