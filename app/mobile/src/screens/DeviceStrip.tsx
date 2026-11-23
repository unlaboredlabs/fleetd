// A phone screen's control strip on the phone (D652), the desktop's strip in iOS's own terms: one slim glass capsule of
// icons over the screen's actions, only the controls its machine says work there (stripOf), each named for VoiceOver.
// Fold (an iPhone Duo's posture: closed, book, open, laptop), text size and location pick from an action sheet; a
// screenshot opens the share sheet. Each press is one screen_control. Its last icon shows the device in 3D or flat.
import { ActionSheetIOS, Alert, Platform, Pressable, Share, StyleSheet, View } from "react-native";
import { useState } from "react";
import { appearanceWord, CONTROL_WORD, latLon, otherAppearance, PLACES, POSTURE, railOf, shotName, TEXT_SIZES, type BrowserSession, type StripControl } from "../desktop";
import { useHub } from "../hubContext";
import { useTheme } from "../theme";
import { Glass } from "../ui/Glass";
import { haptics } from "../ui/haptics";
import { Icon, type IconName } from "../ui/Icon";

const ICON: Readonly<Record<Exclude<StripControl, "appearance">, IconName>> = {
  rotate_left: "rotateLeft",
  rotate_right: "rotateRight",
  fold: "fold",
  home: "home",
  back: "pageBack",
  lock: "lock",
  shake: "shake",
  location: "location",
  screenshot: "screenshot",
  text_size: "textSize",
};

export function DeviceStrip({
  screen,
  name,
  three,
  onThree,
  onChanged,
}: {
  screen: BrowserSession;
  name: string;
  /** The device shows in 3D; pressing the last icon shows it flat, and back. */
  three: boolean;
  onThree: (three: boolean) => void;
  onChanged: () => void;
}) {
  const t = useTheme();
  const { session } = useHub();
  const [busy, setBusy] = useState<StripControl | null>(null);
  // The desktop toolbar's groups (strip.ts railOf): home and rotate; the look, the rest behind More; a Duo's posture.
  const rail = railOf(screen.controls ?? [], screen.folds);
  const look: (StripControl | "more")[] = rail.more.length === 0 ? rail.look : [...rail.look, "more"];
  const posture: StripControl[] = rail.postures.length === 0 ? [] : ["fold"];
  const groups = [rail.buttons, look, posture].filter((g) => g.length > 0);

  const press = async (control: StripControl, value?: string) => {
    haptics.tap();
    setBusy(control);
    const r = await session.call("screen_control", { sessionId: screen.sessionId, control, ...(value === undefined ? {} : { value }) });
    setBusy(null);
    if (!r.ok) {
      haptics.warning();
      Alert.alert(`${CONTROL_WORD[control]} Didn't Work`, r.error.message);
      return;
    }
    onChanged();
    const shot = r.output.screenshot;
    if (control === "screenshot" && shot !== undefined) void Share.share({ url: `data:${shot.mime};base64,${shot.dataB64}`, title: shotName(name, new Date()) });
  };

  // A pick from an action sheet (Android: an alert's buttons), its current one marked.
  const pick = (title: string, options: readonly { readonly label: string; readonly value: string }[], onPick: (value: string) => void, extra?: { label: string; run: () => void }) => {
    const labels = [...options.map((o) => o.label), ...(extra === undefined ? [] : [extra.label])];
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ title, options: [...labels, "Cancel"], cancelButtonIndex: labels.length }, (i) => {
        const o = options[i];
        if (o !== undefined) onPick(o.value);
        else if (i === options.length) extra?.run();
      });
    } else {
      Alert.alert(title, undefined, [...options.map((o) => ({ text: o.label, onPress: () => onPick(o.value) })), { text: "Cancel", style: "cancel" as const }]);
    }
  };

  const onPress = (c: StripControl) => {
    switch (c) {
      case "appearance":
        return void press(c, otherAppearance(screen.appearance));
      case "fold":
        return pick(
          "Posture",
          (screen.folds ?? []).map((f) => ({ label: `${POSTURE[f] ?? f}${f === screen.fold ? " ✓" : ""}`, value: f })),
          (v) => void press(c, v),
        );
      case "text_size":
        return pick(
          "Text Size",
          TEXT_SIZES.map((s) => ({ label: `${s.word}${s.value === screen.textSize ? " ✓" : ""}`, value: s.value })),
          (v) => void press(c, v),
        );
      case "location":
        return pick(
          "Location",
          PLACES.map((p) => ({ label: p.name, value: p.at })),
          (v) => void press(c, v),
          Platform.OS === "ios"
            ? {
                label: "Coordinates…",
                run: () =>
                  Alert.prompt("Location", "Latitude, longitude", (text) => {
                    const at = latLon(text);
                    if (at === null) return haptics.warning();
                    void press(c, at);
                  }),
              }
            : undefined,
        );
      default:
        return void press(c);
    }
  };

  return (
    <Glass style={styles.strip}>
      {groups.map((g, i) => (
        <View key={g.join()} style={[styles.group, i > 0 && styles.apart]}>
          {g.map((c) => {
            const word = c === "more" ? "More" : c === "appearance" ? appearanceWord(screen.appearance) : c === "fold" ? "Posture" : c === "rotate_left" ? "Rotate" : CONTROL_WORD[c];
            const icon: IconName = c === "more" ? "more" : c === "appearance" ? (screen.appearance === "dark" ? "lightMode" : "darkMode") : ICON[c];
            return (
              <Pressable
                key={c}
                accessibilityRole="button"
                accessibilityLabel={word}
                accessibilityState={{ busy: busy === c }}
                disabled={busy === c}
                onPress={() =>
                  c === "more"
                    ? pick(
                        "More",
                        rail.more.map((m) => ({ label: m === "location" ? "Location…" : CONTROL_WORD[m], value: m })),
                        (v) => onPress(v as StripControl),
                      )
                    : onPress(c)
                }
                style={({ pressed }) => [styles.hit, (pressed || busy === c) && styles.pressed]}
              >
                <Icon name={icon} size={18} color={t.label} />
              </Pressable>
            );
          })}
        </View>
      ))}
      <View style={[styles.group, styles.apart]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={three ? "Show It Flat" : "Show It in 3D"}
          onPress={() => {
            haptics.tap();
            onThree(!three);
          }}
          style={({ pressed }) => [styles.hit, pressed && styles.pressed]}
        >
          <Icon name={three ? "flat" : "threeD"} size={18} color={t.label} />
        </Pressable>
      </View>
    </Glass>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: "row", alignItems: "center", height: 44, borderRadius: 22, paddingHorizontal: 6, marginBottom: 10 },
  group: { flexDirection: "row", alignItems: "center" },
  apart: { marginLeft: 6 },
  hit: { width: 36, height: 44, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.5 },
});
