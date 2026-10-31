// A Navi's or agent's live screen, full screen over its chat: the page as its agent sees it, who has control, and the one
// control that matters (Take Over, or Hand Back once it's yours). Opened from the screen's card in the chat, from the
// push that says its agent needs you, or as a screen of your own (New Screen, which is yours from its start and ends
// with End Screen).
//
// It watches the screen through the hub (browser_watch) as the desktop's live view does, drawing at most MAX_FPS frames
// a second, two images stacked so a new frame never flashes while it decodes. Pinch zooms about the fingers, two
// fingers move the zoomed page. Yours, one finger drives the page (screen.ts): a tap clicks, a drag scrolls, a touch
// held a moment presses and drags, for a slider or a press-and-hold check; the keyboard button types into the page.
// Leaving while it's yours asks whether to hand it back first, so its agent isn't left waiting.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Image, Platform, Pressable, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import { GestureDetector, usePanGesture, usePinchGesture, useSimultaneousGestures } from "react-native-gesture-handler";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { zoomAbout, isNavi, type BrowserFrame } from "../desktop";
import { useHub, type RootParams } from "../hubContext";
import { cardOf, clampView, controlLine, controlOf, ENTER, fingerCancel, fingerDown, fingerHeld, fingerMove, fingerUp, FramePacer, HOLD_MS, hostOf, IDLE, BACKSPACE, KIND_WORD, MAX_ZOOM, pixelsPerPoint, toFrame, typed, type Finger, type Size, type Step } from "../screen";
import { space, type, useTheme } from "../theme";
import { Avatar } from "../ui/Avatar";
import { Glass, GlassGroup } from "../ui/Glass";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { dur, ease, useReduceMotion } from "../ui/motion";

const SETTLE = { damping: 26, stiffness: 260, mass: 1 } as const;
/** How far past its bounds a pinch goes before it springs back. */
const OVERZOOM = 1.25;
/** The page's corners at rest, inset from the screen's edges. */
const PAGE_RADIUS = 14;
/** How long the touch hint shows once the page is yours. */
const HINT_MS = 4000;

export function Screen({ navigation, route }: NativeStackScreenProps<RootParams, "Screen">) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const insets = useSafeAreaInsets();
  const { state, session } = useHub();
  const { key, sessionId } = route.params;
  const project = state.projects?.[key];
  const who = project?.title ?? "Its agent";
  const listed = state.screens[key]?.find((s) => s.sessionId === sessionId);

  // Read its screens when they aren't known yet (a push opened it straight away).
  useEffect(() => {
    if (state.screens[key] === undefined) void session.readScreens(key);
  }, [session, key, state.screens]);

  // The frames: watched while this is open, drawn at most MAX_FPS a second, into whichever image isn't on top.
  const [slots, setSlots] = useState<{ readonly a?: BrowserFrame; readonly b?: BrowserFrame; readonly top: "a" | "b" }>({ top: "a" });
  const [newest, setNewest] = useState<BrowserFrame | undefined>(undefined);
  useEffect(() => {
    const pacer = new FramePacer<BrowserFrame>((f) => {
      setNewest(f);
      setSlots((s) => (s.top === "a" ? { ...s, b: f } : { ...s, a: f }));
    });
    const off = session.onFrame((f) => {
      if (f.sessionId === sessionId) pacer.offer(f);
    });
    session.watch(sessionId);
    return () => {
      off();
      pacer.stop();
      session.watch(null);
    };
  }, [session, sessionId]);
  const loaded = (slot: "a" | "b", seq: number) => setSlots((s) => (s[slot]?.seq === seq && s.top !== slot ? { ...s, top: slot } : s));
  const shownFrame = slots[slots.top] ?? slots.a ?? slots.b;

  const card = listed === undefined ? undefined : cardOf(listed);
  const control = controlOf(listed, newest);
  const yours = control === "human";
  const ended = listed !== undefined && listed.state !== "live";
  const own = card?.own === true;

  // Taking over and handing back, with the hub's word on how it went.
  const [asking, setAsking] = useState<"human" | "agent" | "end" | null>(null);
  const setControl = useCallback(
    async (to: "human" | "agent"): Promise<boolean> => {
      setAsking(to);
      const r = await session.control(sessionId, to);
      setAsking(null);
      if (r.ok) {
        haptics.success();
        return true;
      }
      haptics.warning();
      Alert.alert(to === "human" ? "Couldn't Take Over" : "Couldn't Hand Back", r.error.message);
      return false;
    },
    [session, sessionId],
  );
  const end = useCallback(async () => {
    setAsking("end");
    const r = await session.call("screen_end", { sessionId });
    setAsking(null);
    if (!r.ok) return Alert.alert("Couldn't End the Screen", r.error.message);
    haptics.success();
    void session.readScreens(key);
    navigation.goBack();
  }, [session, sessionId, key, navigation]);

  // Leaving while it's yours: hand it back first, or keep it (the card in the chat still opens it).
  const close = () => {
    if (!yours || own || ended) return navigation.goBack();
    const title = `Hand back to ${who}?`;
    const message = `${who} waits while you have control.`;
    const back = () => void setControl("agent").then((ok) => ok && navigation.goBack());
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ title, message, options: ["Hand Back", "Keep Control", "Cancel"], cancelButtonIndex: 2 }, (i) => {
        if (i === 0) back();
        if (i === 1) navigation.goBack();
      });
    } else {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel" },
        { text: "Keep Control", onPress: () => navigation.goBack() },
        { text: "Hand Back", onPress: back },
      ]);
    }
  };

  // The page's box and the frame's size, which the gestures read on the UI thread.
  const [box, setBox] = useState<Size>({ width: 1, height: 1 });
  const frameSize: Size = useMemo(() => ({ width: newest?.width ?? 1280, height: newest?.height ?? 800 }), [newest?.width, newest?.height]);
  const boxV = useSharedValue<Size>(box);
  const frameV = useSharedValue<Size>(frameSize);
  useEffect(() => {
    frameV.value = frameSize;
  }, [frameV, frameSize]);
  const onLayout = (e: LayoutChangeEvent) => {
    const next = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
    setBox(next);
    boxV.value = next;
  };
  const zoom = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const settle = () => {
    "worklet";
    const v = clampView(boxV.value, frameV.value, { zoom: zoom.value, x: x.value, y: y.value });
    zoom.value = withSpring(v.zoom, SETTLE);
    x.value = withSpring(v.x, SETTLE);
    y.value = withSpring(v.y, SETTLE);
  };
  const pinch = usePinchGesture({
    onUpdate: (e) => {
      "worklet";
      const to = Math.min(MAX_ZOOM * OVERZOOM, Math.max(1 / OVERZOOM, zoom.value * e.scaleChange));
      x.value = zoomAbout(x.value, e.focalX - boxV.value.width / 2, zoom.value, to);
      y.value = zoomAbout(y.value, e.focalY - boxV.value.height / 2, zoom.value, to);
      zoom.value = to;
    },
    onFinalize: () => {
      "worklet";
      settle();
    },
  });
  const pan = usePanGesture({
    minPointers: 2,
    onUpdate: (e) => {
      "worklet";
      x.value += e.changeX;
      y.value += e.changeY;
    },
    onFinalize: () => {
      "worklet";
      settle();
    },
  });

  // One finger, on the JS thread: the page's while it's yours (screen.ts's finger), else it moves the zoomed page.
  const finger = useRef<Finger>(IDLE);
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const off = useRef(false);
  const latest = useRef({ yours, box, frameSize });
  latest.current = { yours, box, frameSize };
  const view = () => ({ zoom: zoom.value, x: x.value, y: y.value });
  const touch = (px: number, py: number) => {
    const { box: b, frameSize: f } = latest.current;
    return { at: { x: px, y: py }, frame: toFrame({ x: px, y: py }, b, f, view()), t: Date.now() };
  };
  const apply = (step: Step) => {
    finger.current = step.finger;
    for (const input of step.send) session.input(sessionId, input);
    if (step.send.some((i) => i.kind === "mouse" && i.action === "pressed")) haptics.tap();
  };
  const clearHold = () => {
    if (hold.current !== undefined) clearTimeout(hold.current);
    hold.current = undefined;
  };
  const one = usePanGesture({
    runOnJS: true,
    minDistance: 0,
    maxPointers: 1,
    onBegin: (e) => {
      off.current = false;
      if (!latest.current.yours) return;
      apply(fingerDown(finger.current, touch(e.x, e.y)));
      clearHold();
      hold.current = setTimeout(() => apply(fingerHeld(finger.current)), HOLD_MS);
    },
    onUpdate: (e) => {
      if (off.current) return;
      // A second finger: it's a pinch, not a touch on the page.
      if (e.numberOfPointers > 1) {
        off.current = true;
        clearHold();
        return apply(fingerCancel(finger.current));
      }
      if (!latest.current.yours) {
        x.value += e.changeX;
        y.value += e.changeY;
        return;
      }
      const before = finger.current.t;
      apply(fingerMove(finger.current, touch(e.x, e.y), pixelsPerPoint(latest.current.box, latest.current.frameSize, view())));
      if (before === "down" && (finger.current as Finger).t === "scrolling") clearHold();
    },
    onFinalize: (e) => {
      clearHold();
      if (!latest.current.yours) {
        settle();
        return;
      }
      if (off.current || e.canceled) apply(fingerCancel(finger.current));
      else apply(fingerUp(finger.current, touch(e.x, e.y)));
    },
  });
  useEffect(() => () => clearHold(), []);
  // Handed back or ended mid-touch: the finger lets go.
  useEffect(() => {
    if (!yours) finger.current = fingerCancel(finger.current).finger;
  }, [yours]);
  const gestures = useSimultaneousGestures(pinch, pan, one);
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: zoom.value }] }));

  // The keyboard: a hidden field whose every change goes to the page (screen.ts typed), then is emptied.
  const keys = useRef<ComponentRef<typeof TextInput>>(null);
  const [typing, setTyping] = useState(false);
  const toggleKeys = () => {
    haptics.tap();
    if (typing) keys.current?.blur();
    else keys.current?.focus();
  };
  const onKeys = (next: string) => {
    for (const input of typed(next)) session.input(sessionId, input);
    keys.current?.clear();
  };
  useEffect(() => {
    if (!yours) keys.current?.blur();
  }, [yours]);

  // The touch hint, once each time the page becomes yours.
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!yours) return setHint(false);
    setHint(true);
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [yours]);

  // The page at rest: the whole frame, fit in the box, its corners rounded.
  const fit = Math.min(box.width / frameSize.width, box.height / frameSize.height);
  const page = { width: frameSize.width * fit, height: frameSize.height * fit };
  const host = hostOf(newest?.url);
  const kind = card === undefined ? "screen" : KIND_WORD[card.kind];
  const status = ended ? "Ended" : control === "agent" && card?.reason === undefined && newest === undefined ? "Connecting…" : controlLine(control, who, own);
  const ground = t.dark ? "#000000" : t.grouped;
  const navi = project !== undefined && isNavi(project);

  const image = (slot: "a" | "b") => {
    const f = slots[slot];
    if (f === undefined) return null;
    return (
      <Image
        key={slot}
        source={{ uri: `data:image/jpeg;base64,${f.jpegB64}` }}
        onLoad={() => loaded(slot, f.seq)}
        fadeDuration={0}
        style={[StyleSheet.absoluteFill, { zIndex: slots.top === slot ? 1 : 0 }]}
        accessibilityIgnoresInvertColors
      />
    );
  };

  return (
    <View style={[styles.fill, { backgroundColor: ground }]}>
      <StatusBar style={t.dark ? "light" : "dark"} />
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <View style={[styles.stage, { paddingTop: insets.top + BAR + space.sm, paddingBottom: space.sm }]}>
          <GestureDetector gesture={gestures}>
            <View
              style={styles.box}
              onLayout={onLayout}
              accessible
              accessibilityLabel={`${who}'s ${kind}${host === "" ? "" : `, ${host}`}. ${yours ? "Tap to click, drag to scroll, touch and hold to drag." : "Pinch to zoom."}`}
            >
              <Animated.View style={[{ width: page.width, height: page.height }, moved]}>
                <View style={[styles.page, { borderRadius: PAGE_RADIUS, backgroundColor: t.dark ? "#1C1C1E" : "#FFFFFF" }, yours && { borderColor: t.accent, borderWidth: 2 }]}>
                  {image("a")}
                  {image("b")}
                  {shownFrame === undefined && !ended ? (
                    <View style={styles.center}>
                      <ActivityIndicator color={t.secondary} />
                      <Text style={[type.footnote, { color: t.secondary }]}>{`Connecting to ${who}'s ${kind}…`}</Text>
                    </View>
                  ) : null}
                </View>
              </Animated.View>
            </View>
          </GestureDetector>
          {ended ? (
            <Animated.View entering={FadeIn.duration(reduce ? 0 : dur.quick).easing(ease.snap)} style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
              <Glass style={styles.endedGlass}>
                <Text style={[type.headline, { color: t.label }]}>This screen has ended</Text>
                <Text style={[type.footnote, styles.centerText, { color: t.secondary }]}>Its recording is in the desktop app, under Screens.</Text>
              </Glass>
            </Animated.View>
          ) : null}
        </View>

        {/* What it asks of you, under the bar, while it waits for you. */}
        {card?.reason !== undefined && !ended ? (
          <Animated.View entering={FadeIn.duration(reduce ? 0 : dur.quick).easing(ease.snap)} exiting={FadeOut.duration(reduce ? 0 : dur.quick)} style={[styles.ask, { top: insets.top + BAR + space.md }]}>
            <Glass style={styles.askGlass}>
              <Icon name="hand" size={18} color={t.warning} />
              <View style={styles.askText}>
                <Text style={[type.subhead, styles.strong, { color: t.label }]}>{`${who} needs you`}</Text>
                <Text style={[type.subhead, { color: t.label }]}>{card.reason}</Text>
              </View>
            </Glass>
          </Animated.View>
        ) : null}

        {/* The bar: close, and who it is and who drives. */}
        <View style={[styles.bar, { top: insets.top }]} pointerEvents="box-none">
          <Glass interactive style={styles.round}>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.roundHit} onPress={close}>
              <Icon name="close" size={20} color={t.label} weight="semibold" />
            </Pressable>
          </Glass>
          <Glass style={styles.title}>
            <Avatar name={who} navi={navi} size={28} picture={project} />
            <View style={styles.titleText}>
              <Text style={[type.headline, { color: t.label }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                {host === "" ? who : host}
              </Text>
              <Text style={[type.caption2, { color: yours ? t.accent : t.secondary }]} numberOfLines={1} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
                {status}
              </Text>
            </View>
          </Glass>
          <View style={styles.round} />
        </View>

        {/* The touch hint, a moment after it's yours. */}
        {hint && !typing ? (
          <Animated.View entering={FadeIn.duration(reduce ? 0 : dur.base).easing(ease.out)} exiting={FadeOut.duration(reduce ? 0 : dur.base)} style={[styles.hint, { bottom: insets.bottom + TOOLBAR + space.lg }]} pointerEvents="none">
            <Glass style={styles.hintGlass}>
              <Text style={[type.footnote, { color: t.label }]}>Tap to click · drag to scroll · hold to drag</Text>
            </Glass>
          </Animated.View>
        ) : null}

        {/* The one control, and the keyboard while it's yours. */}
        <View style={[styles.toolbar, { paddingBottom: typing ? space.sm : Math.max(insets.bottom, space.md) }]} pointerEvents="box-none">
          {ended ? (
            <Action label="Done" onPress={() => navigation.goBack()} prominent />
          ) : yours ? (
            <GlassGroup style={styles.row} spacing={10}>
              <Glass interactive style={styles.round}>
                <Pressable accessibilityRole="button" accessibilityLabel={typing ? "Hide the keyboard" : "Type on the page"} accessibilityState={{ selected: typing }} style={styles.roundHit} onPress={toggleKeys}>
                  <Icon name={typing ? "keyboardHide" : "keyboard"} size={20} color={typing ? t.accent : t.label} />
                </Pressable>
              </Glass>
              {own ? (
                <Action label="End Screen" icon="close" destructive busy={asking === "end"} onPress={() => void end()} />
              ) : (
                <Action label="Hand Back" icon="handBack" prominent busy={asking === "agent"} onPress={() => void setControl("agent")} />
              )}
            </GlassGroup>
          ) : control === "handing_back" ? (
            <Action label={`Handing Back to ${who}…`} busy />
          ) : (
            <Action label="Take Over" icon="hand" prominent busy={asking === "human"} onPress={() => void setControl("human")} />
          )}
        </View>
        <TextInput
          ref={keys}
          style={styles.keys}
          onChangeText={onKeys}
          onKeyPress={(e) => {
            if (e.nativeEvent.key === "Backspace") for (const input of BACKSPACE) session.input(sessionId, input);
          }}
          onSubmitEditing={() => {
            for (const input of ENTER) session.input(sessionId, input);
          }}
          submitBehavior="submit"
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          autoCorrect={false}
          autoCapitalize="none"
          spellCheck={false}
          autoComplete="off"
          textContentType="none"
          keyboardAppearance={t.dark ? "dark" : "light"}
          caretHidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      </KeyboardAvoidingView>
    </View>
  );
}

/** A capsule of glass with its words: the screen's one action, prominent (tinted) or plain. */
function Action({ label, icon, onPress, prominent = false, destructive = false, busy = false }: { label: string; icon?: "hand" | "handBack" | "close"; onPress?: () => void; prominent?: boolean; destructive?: boolean; busy?: boolean }) {
  const t = useTheme();
  const tint = prominent ? t.accentFill : destructive ? t.danger : undefined;
  const ink = tint === undefined ? t.label : t.onAccent;
  return (
    <Glass interactive style={styles.action} {...(tint === undefined ? {} : { tint })}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ busy, disabled: onPress === undefined }}
        disabled={busy || onPress === undefined}
        onPress={() => {
          haptics.tap();
          onPress?.();
        }}
        style={({ pressed }) => [styles.actionHit, pressed && styles.pressed]}
      >
        {busy ? <ActivityIndicator color={ink} /> : icon === undefined ? null : <Icon name={icon} size={17} color={ink} weight="semibold" />}
        <Text style={[type.headline, { color: ink }]} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </Glass>
  );
}

/** The bar's height under the status bar, and the toolbar's over the home indicator. */
const BAR = 52;
const TOOLBAR = 52;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  stage: { flex: 1, paddingHorizontal: space.sm },
  box: { flex: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  page: { flex: 1, overflow: "hidden", borderCurve: "continuous" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm },
  centerText: { textAlign: "center" },
  endedGlass: { borderRadius: 22, borderCurve: "continuous", paddingHorizontal: space.xl, paddingVertical: space.lg, alignItems: "center", gap: space.xs, maxWidth: 300 },
  bar: { position: "absolute", left: space.lg, right: space.lg, height: BAR, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  round: { width: 48, height: 48, borderRadius: 24 },
  roundHit: { flex: 1, alignItems: "center", justifyContent: "center" },
  title: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: space.sm, borderRadius: 24, height: 48, paddingLeft: 10, paddingRight: space.lg },
  titleText: { flexShrink: 1 },
  ask: { position: "absolute", left: space.lg, right: space.lg },
  askGlass: { flexDirection: "row", alignItems: "flex-start", gap: space.md, borderRadius: 22, borderCurve: "continuous", paddingHorizontal: space.lg, paddingVertical: space.md },
  askText: { flex: 1, gap: 2 },
  strong: { fontWeight: "600" },
  hint: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  hintGlass: { borderRadius: 18, paddingHorizontal: space.lg, paddingVertical: space.sm },
  // In the column under the page, not over it: the keyboard's padding lifts it with the page above.
  toolbar: { alignItems: "center", paddingTop: space.sm },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  action: { height: 48, borderRadius: 24, minWidth: 180 },
  actionHit: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: space.xl },
  pressed: { opacity: 0.6 },
  keys: { position: "absolute", width: 1, height: 1, opacity: 0, left: -10, top: -10 },
});
