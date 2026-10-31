// Import Memory, pushed from Settings, as Grok's: two numbered steps, the export prompt on a card with Copy Prompt
// (a haptic and "Copied"), a paste box that grows with what's pasted, and Add to Memory on glass at the bottom, riding
// on the keyboard, greyed while the box is empty. The hub distills the paste into entries in the person's own memory
// (memoryImport.ts) and the screen says how many it added, or why it couldn't; the paste stays then, to try again.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useMemo, useReducer, useState } from "react";
import { Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { KeyboardAwareScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHub, type SettingsParams } from "../hubContext";
import { addedWords, canAdd, importClient, importStep, initialImport } from "../memoryImport";
import { shape, space, type, useTheme } from "../theme";
import { Button } from "../ui/Button";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { dur, ease, grows, rowIn, useReduceMotion } from "../ui/motion";
import { SkeletonBlock } from "../ui/Skeleton";
import { errorWords, Problem } from "./manage/parts";

/** How long Copy Prompt says Copied, as a code block's Copy. */
const COPIED_MS = 1600;
/** The paste box's height while empty: room for a few lines, as Grok's. */
const BOX_MIN = 168;

export function ImportMemory({ navigation }: NativeStackScreenProps<SettingsParams, "ImportMemory">) {
  const t = useTheme();
  const { session } = useHub();
  const client = useMemo(() => importClient(session), [session]);
  const [s, send] = useReducer(importStep, initialImport);
  const reduce = useReduceMotion();
  const insets = useSafeAreaInsets();
  // The dock's height, so the last of the page scrolls clear of it.
  const [dock, setDock] = useState(0);

  useEffect(() => {
    if (s.prompt.t !== "loading") return;
    let live = true;
    void client.prompt().then((result) => {
      if (live) send({ t: "prompt", result });
    });
    return () => {
      live = false;
    };
  }, [client, s.prompt.t]);
  useEffect(() => {
    if (!s.copied) return;
    const timer = setTimeout(() => send({ t: "copiedShown" }), COPIED_MS);
    return () => clearTimeout(timer);
  }, [s.copied]);

  const copy = () => {
    if (s.prompt.t !== "ready") return;
    void Clipboard.setStringAsync(s.prompt.text);
    haptics.success();
    send({ t: "copied" });
  };
  const add = async () => {
    if (!canAdd(s)) return;
    Keyboard.dismiss();
    haptics.tap();
    send({ t: "add" });
    const result = await client.add(s.text);
    send({ t: "added", result });
    if (result.ok) haptics.success();
    else haptics.warning();
  };

  const done = s.phase.t === "done" ? addedWords(s.phase.imported) : null;
  const working = s.phase.t === "working";
  // Pressed to go further: back to Settings once added.
  const button = done !== null ? { label: "Done", onPress: () => navigation.goBack(), disabled: false } : { label: "Add to Memory", onPress: () => void add(), disabled: !canAdd(s) };
  const lift = Math.max(insets.bottom - space.sm, 0);

  return (
    <View style={[styles.fill, { backgroundColor: t.grouped }]}>
      <KeyboardAwareScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        bottomOffset={dock - lift + space.lg}
        contentContainerStyle={{ paddingBottom: dock + space.lg }}
      >
        <Step n={1} text="Copy this prompt into a chat with your other assistant" />
        <View style={[styles.card, { backgroundColor: t.cell }]}>
          <View style={styles.prompt}>
            {s.prompt.t === "loading" ? (
              <View style={styles.lines} accessibilityLabel="Loading the prompt">
                {[1, 0.94, 0.97, 0.62].map((w, i) => (
                  <SkeletonBlock key={i} width={`${String(w * 100)}%`} height={14} />
                ))}
              </View>
            ) : s.prompt.t === "ready" ? (
              <Text style={[type.callout, styles.promptText, { color: t.secondary }]} numberOfLines={6}>
                {s.prompt.text}
              </Text>
            ) : (
              <Text style={[type.callout, { color: t.danger }]} accessibilityRole="alert">
                {`The prompt didn't load: ${errorWords(s.prompt.error)}`}
              </Text>
            )}
          </View>
          <View style={[styles.rule, { backgroundColor: t.separator }]} />
          {s.prompt.t === "failed" ? (
            <Action label="Try Again" icon="update" onPress={() => send({ t: "reloadPrompt" })} />
          ) : (
            <Action label={s.copied ? "Copied" : "Copy Prompt"} icon={s.copied ? "done" : "copy"} onPress={copy} disabled={s.prompt.t !== "ready"} keyed={s.copied ? "copied" : "copy"} />
          )}
        </View>
        <Step n={2} text="Paste its answer below to add it to your memory" />
        {done === null ? (
          <Animated.View {...grows(reduce)} style={[styles.card, { backgroundColor: t.cell }]}>
            <TextInput
              value={s.text}
              onChangeText={(text) => send({ t: "typed", text })}
              placeholder="Paste the answer here"
              placeholderTextColor={t.tertiary}
              multiline
              // The box grows with the paste; the page scrolls, not the box.
              scrollEnabled={false}
              editable={!working}
              autoCorrect={false}
              selectionColor={t.accent}
              textAlignVertical="top"
              accessibilityLabel="The other assistant's answer"
              style={[type.body, styles.box, { color: working ? t.secondary : t.label }]}
            />
          </Animated.View>
        ) : (
          <Animated.View entering={rowIn(reduce)} style={[styles.card, styles.result, { backgroundColor: t.cell }]} accessibilityLiveRegion="polite" accessible>
            <Icon name="check" size={44} color={t.success} />
            <Text style={[type.title3, styles.center, { color: t.label }]}>{done.title}</Text>
            <Text style={[type.subhead, styles.center, { color: t.secondary }]}>{done.detail}</Text>
          </Animated.View>
        )}
        {working ? (
          <Animated.Text entering={FadeIn.duration(reduce ? 0 : dur.quick).easing(ease.snap)} style={[type.footnote, styles.note, { color: t.secondary }]} accessibilityLiveRegion="polite">
            Picking out what to remember. This takes about a minute.
          </Animated.Text>
        ) : null}
        <Problem text={s.phase.t === "failed" ? `Not added: ${errorWords(s.phase.error)}` : undefined} />
      </KeyboardAwareScrollView>
      {/* The button rides on the keyboard, over a fade of the page's ground, as a chat's composer. */}
      <KeyboardStickyView offset={{ closed: 0, opened: lift }} style={styles.dock} pointerEvents="box-none">
        {Platform.OS === "ios" ? <LinearGradient pointerEvents="none" colors={[t.dark ? "rgba(0,0,0,0)" : "rgba(242,242,247,0)", t.grouped]} locations={[0, 0.45]} style={StyleSheet.absoluteFill} /> : null}
        <View style={[styles.dockRow, { paddingBottom: Math.max(insets.bottom, space.lg) }]} onLayout={(e) => setDock(e.nativeEvent.layout.height)}>
          <Button size="large" label={button.label} onPress={button.onPress} disabled={button.disabled} busy={working} />
        </View>
      </KeyboardStickyView>
    </View>
  );
}

/** A step's number in a small round badge, and what to do, above its card. */
function Step({ n, text }: { n: number; text: string }) {
  const t = useTheme();
  return (
    <View style={styles.step} accessible accessibilityRole="header" accessibilityLabel={`Step ${String(n)}: ${text}`}>
      <View style={[styles.badge, { backgroundColor: t.accentSoft }]}>
        <Text style={[type.footnote, styles.badgeText, { color: t.accent }]} maxFontSizeMultiplier={1.4}>
          {n}
        </Text>
      </View>
      <Text style={[type.subhead, styles.grow, { color: t.secondary }]}>{text}</Text>
    </View>
  );
}

/** A card's one action under a hairline, as a grouped list's button row; `keyed` cross-fades a change of words. */
function Action({ label, icon, onPress, disabled = false, keyed }: { label: string; icon: "copy" | "done" | "update"; onPress: () => void; disabled?: boolean; keyed?: string }) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const ink = disabled ? t.tertiary : t.accent;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}>
      {({ pressed }) => (
        <View style={[styles.action, pressed && { backgroundColor: t.fillQuiet }]}>
          <Animated.View key={keyed} {...(keyed === undefined || reduce ? {} : { entering: FadeIn.duration(dur.quick).easing(ease.snap) })} style={styles.actionRow}>
            <Icon name={icon} size={17} color={ink} weight="medium" />
            <Text style={[type.body, { color: ink }]}>{label}</Text>
          </Animated.View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1 },
  step: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginHorizontal: space.lg * 2, marginTop: space.xl, marginBottom: space.sm + 2 },
  badge: { width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", marginTop: 0 },
  badgeText: { fontWeight: "600", fontVariant: ["tabular-nums"] },
  card: { marginHorizontal: space.lg, borderRadius: shape.group, borderCurve: "continuous", overflow: "hidden" },
  prompt: { paddingHorizontal: space.lg, paddingTop: 14, paddingBottom: 14 },
  promptText: { lineHeight: 23 },
  lines: { gap: 9, paddingVertical: 4 },
  rule: { height: StyleSheet.hairlineWidth, marginLeft: space.lg },
  action: { minHeight: shape.row, justifyContent: "center", paddingHorizontal: space.lg },
  actionRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  box: { minHeight: BOX_MIN, paddingHorizontal: space.lg, paddingTop: 14, paddingBottom: 14 },
  result: { alignItems: "center", gap: space.xs, paddingHorizontal: space.xl, paddingVertical: space.xl },
  center: { textAlign: "center" },
  note: { marginHorizontal: space.lg * 2, paddingTop: 7 },
  dock: { position: "absolute", left: 0, right: 0, bottom: 0 },
  dockRow: { paddingHorizontal: space.xl, paddingTop: space.lg },
});
