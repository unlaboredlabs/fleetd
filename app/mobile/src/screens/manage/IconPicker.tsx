// A project's icon, from its screen (Info): a sheet with its bot or photo large at the top, its bot's shape (the five
// bodies, BOT_BODIES, each a small bot in its color) and color (rows of swatches from the palette, BOT_PAINT), the
// picked one of each ringed, and Choose Photo / Take Photo (then Move and Scale) /
// Remove Photo, as the desktop's Settings › Projects › Icon and Color. Every project without a photo wears a bot,
// whose motion shows what it's doing; its shape and color are what to pick. A pick shows at once and is saved with
// project_settings_set; the hub's project.settings event brings it to every app.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { BOT_COLORS, BOT_PAINT, BOT_SHAPES, botColorLabel, botShapeLabel, colorOf, shapeOf, type BotColorName, type BotShapeName } from "../../desktop";
import { useHub, type RootParams } from "../../hubContext";
import { space, useTheme } from "../../theme";
import { Avatar } from "../../ui/Avatar";
import { Being } from "../../ui/Being";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { useBot } from "../../ui/botState";
import { removePicture, setBotColor, setBotShape } from "./api";
import { errorWords, sheetOptions } from "./parts";
import { fromCamera, fromLibrary } from "./pick";

const PREVIEW = 112;
/** A shape's bot, in its ring. */
const SHAPE = 34;
/** A swatch's side, its ring around it, and the room between two rings. */
const SWATCH = 30;
const GAP = 16;
/** Six to a row, as a color picker sets them: the palette's eleven sit in two rows, the second centred. */
const ROW = 6 * (SWATCH + 6) + 5 * GAP;

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
  const [pickedShape, setPickedShape] = useState<{ shape: BotShapeName; over: BotShapeName } | null>(null);
  useEffect(() => {
    navigation.setOptions(sheetOptions(t, () => navigation.goBack(), { label: "Done", enabled: true, busy, onPress: () => navigation.goBack() }, !busy));
  });

  if (p === undefined) {
    return <EmptyState icon="folder" title="Not Here" body="The workspace doesn't list it any more." />;
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

  const saved = colorOf(p.avatarColor);
  const savedShape = shapeOf(p.avatarShape);
  // Once the hub names another value than the one a pick was made over, the pick is done with.
  if (picked !== null && picked.over !== saved) setPicked(null);
  if (pickedShape !== null && pickedShape.over !== savedShape) setPickedShape(null);
  const color = picked !== null && picked.over === saved ? picked.color : saved;
  const shape = pickedShape !== null && pickedShape.over === savedShape ? pickedShape.shape : savedShape;
  const pickShape = (next: BotShapeName) => {
    if (next === shape) return;
    haptics.select();
    const pick = { shape: next, over: savedShape };
    setPickedShape(pick);
    void setBotShape(session, p, next).then((r) => {
      if (r.ok) return;
      setPickedShape((now) => (now === pick ? null : now));
      Alert.alert("Couldn't change its shape", errorWords(r.error));
    });
  };
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
        <Avatar name={p.title} size={PREVIEW} picture={{ ...p, avatarColor: color, avatarShape: shape }} bot={bot} />
      </View>
      <ListSection header="Shape">
        <View key="shapes" style={styles.shapes} accessibilityRole="radiogroup" accessibilityLabel="Shape">
          {BOT_SHAPES.map((s) => (
            <Pressable
              key={s}
              onPress={() => pickShape(s)}
              hitSlop={4}
              accessibilityRole="radio"
              accessibilityLabel={botShapeLabel(s)}
              accessibilityState={{ checked: s === shape }}
              style={({ pressed }) => [styles.shapeRing, { borderColor: s === shape ? t.label : "transparent" }, pressed && styles.pressed]}
            >
              <Being state="idle" size={SHAPE} color={color} shape={s} />
            </Pressable>
          ))}
        </View>
      </ListSection>
      <ListSection header="Color" {...(p.avatar === undefined ? {} : { footer: "Its bot wears them when you remove the photo." })}>
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
  shapes: { flexDirection: "row", justifyContent: "space-between", width: ROW, alignSelf: "center", paddingVertical: space.md },
  shapeRing: { width: SHAPE + 16, height: SHAPE + 16, borderRadius: 12, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  swatches: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: GAP, width: ROW, alignSelf: "center", paddingVertical: space.md },
  ring: { width: SWATCH + 6, height: SWATCH + 6, borderRadius: (SWATCH + 6) / 2, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  swatch: { width: SWATCH - 4, height: SWATCH - 4, borderRadius: (SWATCH - 4) / 2 },
  pressed: { opacity: 0.6 },
});
