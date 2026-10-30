// A picked or taken photo moved and scaled in a circle before it becomes a project's or Navi's picture, as iOS's own
// Move and Scale: black, the circle clear, the rest dimmed; pinch to zoom about the fingers, drag to move, and it
// springs back so the circle stays covered (the desktop's shared/crop.ts). Cancel goes back; Choose sends the photo as
// it was picked with the square under the circle (setPicture), and the hub keeps that square alone, small and without
// its metadata.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { File } from "expo-file-system";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture, usePinchGesture, useSimultaneousGestures } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { baseScale, clampPan, clampZoom, cropOf, MAX_ZOOM, zoomAbout } from "../../desktop";
import { useHub, type RootParams } from "../../hubContext";
import { space, type } from "../../theme";
import { haptics } from "../../ui/haptics";
import { setPicture } from "./api";
import { errorWords } from "./parts";

const SETTLE = { damping: 26, stiffness: 260, mass: 1 } as const;
/** How far past its bounds a pinch goes before it resists. */
const OVERZOOM = 1.25;

export function Photo({ navigation, route }: NativeStackScreenProps<RootParams, "Photo">) {
  const { key, uri, width, height, mime } = route.params;
  const { session, state } = useHub();
  const project = state.projects?.[key];
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
  const picture = { width, height };
  const circle = Math.min(win.width - space.md * 2, win.height * 0.62);
  const s = baseScale(picture, circle);
  const zoom = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);

  const settle = () => {
    "worklet";
    const k = clampZoom(zoom.value);
    const pan = clampPan(picture, circle, k, zoom.value === k ? x.value : zoomAbout(x.value, 0, zoom.value, k), zoom.value === k ? y.value : zoomAbout(y.value, 0, zoom.value, k));
    zoom.value = withSpring(k, SETTLE);
    x.value = withSpring(pan.x, SETTLE);
    y.value = withSpring(pan.y, SETTLE);
  };
  const pinch = usePinchGesture({
    enabled: !saving,
    onUpdate: (e) => {
      "worklet";
      const to = Math.min(MAX_ZOOM * OVERZOOM, Math.max(1 / OVERZOOM, zoom.value * e.scaleChange));
      // The fingers' point, from the circle's centre (the screen's), stays under them.
      x.value = zoomAbout(x.value, e.focalX - win.width / 2, zoom.value, to);
      y.value = zoomAbout(y.value, e.focalY - win.height / 2, zoom.value, to);
      zoom.value = to;
    },
    onFinalize: () => {
      "worklet";
      settle();
    },
  });
  const pan = usePanGesture({
    enabled: !saving,
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
  const gestures = useSimultaneousGestures(pinch, pan);
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: zoom.value }] }));

  const choose = async () => {
    if (project === undefined) return navigation.goBack();
    setSaving(true);
    try {
      const bytes = await new File(uri).bytes();
      const r = await setPicture(session, project, bytes, mime, cropOf(picture, circle, zoom.value, x.value, y.value));
      if (!r.ok) {
        setSaving(false);
        haptics.warning();
        return Alert.alert("Couldn't set the picture", errorWords(r.error));
      }
      haptics.success();
      navigation.goBack();
    } catch {
      setSaving(false);
      Alert.alert("Couldn't read the photo", "Pick it again.");
    }
  };

  // The dimmed rest: a ring as wide as the screen around the circle.
  const ring = Math.max(win.width, win.height);
  return (
    <View style={styles.fill}>
      <StatusBar style="light" />
      <GestureDetector gesture={gestures}>
        <View style={styles.fill} accessible accessibilityLabel="Photo. Pinch to zoom, drag to move.">
          <Animated.Image
            source={{ uri }}
            style={[{ position: "absolute", width: width * s, height: height * s, left: (win.width - width * s) / 2, top: (win.height - height * s) / 2 }, moved]}
          />
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              width: circle + ring * 2,
              height: circle + ring * 2,
              left: (win.width - circle) / 2 - ring,
              top: (win.height - circle) / 2 - ring,
              borderRadius: circle / 2 + ring,
              borderWidth: ring,
              borderColor: "rgba(0,0,0,0.62)",
            }}
          />
        </View>
      </GestureDetector>
      <Text style={[type.headline, styles.title, { top: insets.top + space.md }]} accessibilityRole="header">
        Move and Scale
      </Text>
      <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
        <Pressable accessibilityRole="button" hitSlop={12} disabled={saving} onPress={() => navigation.goBack()} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
          <Text style={[type.body, styles.label]}>Cancel</Text>
        </Pressable>
        {saving ? (
          <ActivityIndicator color="#FFFFFF" style={styles.button} />
        ) : (
          <Pressable accessibilityRole="button" hitSlop={12} onPress={() => void choose()} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
            <Text style={[type.body, styles.label, styles.strong]}>Choose</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#000000", overflow: "hidden" },
  title: { position: "absolute", left: 0, right: 0, textAlign: "center", color: "#FFFFFF" },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", justifyContent: "space-between", paddingHorizontal: space.lg, paddingTop: space.md },
  button: { minWidth: 64, minHeight: 44, justifyContent: "center" },
  label: { color: "#FFFFFF" },
  strong: { fontWeight: "600", textAlign: "right" },
  pressed: { opacity: 0.5 },
});
