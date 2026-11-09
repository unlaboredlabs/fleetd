// A project's icon, from its screen (Info): a sheet with its bot or photo large at the top, its bot's color (a row of
// swatches from the palette, BOT_PAINT, the picked one ringed), and Choose Photo / Take Photo (then Move and Scale) /
// Remove Photo, as the desktop's Settings › Projects › Icon and Color. Every project without a photo wears the same
// bot, whose motion shows what it's doing; its color is the one thing to pick. A pick shows at once and is saved with
// project_settings_set; the hub's project.settings event brings it to every app.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { BOT_COLORS, BOT_PAINT, botColorLabel, type BotColorName } from "../../desktop";
import { useHub, type RootParams } from "../../hubContext";
import { space, useTheme } from "../../theme";
import { Avatar } from "../../ui/Avatar";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { useBot } from "../../ui/botState";
import { removePicture, setBotColor } from "./api";
import { errorWords, sheetOptions } from "./parts";
import { fromCamera, fromLibrary } from "./pick";

const PREVIEW = 112;
/** A swatch's side, its ring around it. */
const SWATCH = 30;

export function IconPicker({ navigation, route }: NativeStackScreenProps<RootParams, "Icon">) {
  const t = useTheme();
  const { state, session } = useHub();
  const key = route.params.key;
  const p = state.projects?.[key];
  const bot = useBot(key);
  const [busy, setBusy] = useState(false);
  // The color in flight, with the color it was picked over: shown until the hub's summary names another (this one,
  // or another device's).
  const [picked, setPicked] = useState<{ color: BotColorName; over: BotColorName } | null>(null);
  useEffect(() => {
    navigation.setOptions(sheetOptions(t, () => navigation.goBack(), { label: "Done", enabled: true, busy, onPress: () => navigation.goBack() }, !busy));
  });

  if (p === undefined) {
    return <EmptyState icon="folder" title="Not Here" body="The hub doesn't list it any more." />;
  }
  const photo = (from: () => Promise<Awaited<ReturnType<typeof fromLibrary>>>) => () =>
    void from().then((got) => {
      if (got === null) return;
      navigation.navigate("Photo", { key, ...got });
    });
  const remove = () => {
    setBusy(true);
    void removePicture(session, p).then((r) => {
      setBusy(false);
      if (!r.ok) return Alert.alert("Couldn't remove the photo", errorWords(r.error));
      haptics.success();
    });
  };

  const saved = (BOT_COLORS as readonly string[]).includes(p.avatarColor ?? "") ? (p.avatarColor as BotColorName) : "slate";
  const color = picked !== null && picked.over === saved ? picked.color : saved;
  const pick = (next: BotColorName) => {
    if (next === color) return;
    haptics.select();
    const pick = { color: next, over: saved };
    setPicked(pick);
    void setBotColor(session, p, next).then((r) => {
      if (r.ok) return;
      setPicked((now) => (now === pick ? null : now));
      Alert.alert("Couldn't change its color", errorWords(r.error));
    });
  };

  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <View style={styles.preview} accessible accessibilityRole="image" accessibilityLabel={p.avatar === undefined ? "Its bot" : "Its photo"}>
        <Avatar name={p.title} size={PREVIEW} picture={{ ...p, avatarColor: color }} bot={bot} />
      </View>
      <ListSection header="Color" {...(p.avatar === undefined ? {} : { footer: "Its bot wears it when you remove the photo." })}>
        <View key="colors" style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel="Color">
          {BOT_COLORS.map((c) => (
            <Pressable
              key={c}
              onPress={() => pick(c)}
              hitSlop={7}
              accessibilityRole="radio"
              accessibilityLabel={botColorLabel(c)}
              accessibilityState={{ checked: c === color }}
              style={({ pressed }) => [styles.ring, { borderColor: c === color ? t.label : "transparent" }, pressed && styles.pressed]}
            >
              <View style={[styles.swatch, { backgroundColor: BOT_PAINT[c][t.dark ? "dark" : "light"].body }]} />
            </Pressable>
          ))}
        </View>
      </ListSection>
      <ListSection>
        <ListRow icon="photos" title="Choose Photo" onPress={photo(fromLibrary)} chevron={false} />
        <ListRow icon="takePhoto" title="Take Photo" onPress={photo(fromCamera)} chevron={false} />
        {p.avatar === undefined ? null : <ListRow title="Remove Photo" destructive onPress={busy ? () => undefined : remove} chevron={false} />}
      </ListSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: space.xxl },
  preview: { alignItems: "center", paddingTop: space.lg, paddingBottom: space.xl },
  swatches: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: space.md, paddingVertical: space.md },
  ring: { width: SWATCH + 6, height: SWATCH + 6, borderRadius: (SWATCH + 6) / 2, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  swatch: { width: SWATCH - 4, height: SWATCH - 4, borderRadius: (SWATCH - 4) / 2 },
  pressed: { opacity: 0.6 },
});
