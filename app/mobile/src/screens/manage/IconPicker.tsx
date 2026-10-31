// A project's or Navi's icon, from its screen (Info): a sheet with the icon large at the top, the built-in faces in a
// grid in the color picked, the colors under them, and Choose Photo / Take Photo (then Move and Scale) / Remove Photo,
// as the desktop's Settings › Projects › Icon. A face or color shows at once in the large icon; Done sends it
// (project_icon_set, which takes the place of a picture), Cancel leaves the icon as it was. The last choice wins: a
// photo chosen after a face (iconPick.ts) shows, and Done keeps it.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { ICON_COLORS, ICON_FACES, isNavi, type IconColor, type IconFace, type ProjectIcon } from "../../desktop";
import { useHub, type RootParams } from "../../hubContext";
import { shape, space, useTheme } from "../../theme";
import { Avatar, iconSource } from "../../ui/Avatar";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { removePicture, setIcon } from "./api";
import { pickOver, standing, type Pick } from "./iconPick";
import { errorWords, sheetOptions } from "./parts";
import { fromCamera, fromLibrary } from "./pick";

const PREVIEW = 112;
const FACE = 76;
const SWATCH = 34;

export function IconPicker({ navigation, route }: NativeStackScreenProps<RootParams, "Icon">) {
  const t = useTheme();
  const { state, session } = useHub();
  const key = route.params.key;
  const p = state.projects?.[key];
  // A face or color tapped and not yet sent: the large icon shows it over the picture, until a newer photo.
  const [pick, setPick] = useState<Pick | null>(null);
  const [busy, setBusy] = useState(false);
  const picked = standing(pick, p?.avatar);
  const current = picked ?? p?.icon;
  const hasPicture = p?.avatar !== undefined && picked === null;

  const done = () => {
    if (p === undefined || picked === null) return navigation.goBack();
    setBusy(true);
    void setIcon(session, p, picked).then((r) => {
      setBusy(false);
      if (!r.ok) return Alert.alert("Couldn't change the icon", errorWords(r.error));
      haptics.success();
      navigation.goBack();
    });
  };
  useEffect(() => {
    navigation.setOptions(sheetOptions(t, () => navigation.goBack(), { label: "Done", enabled: true, busy, onPress: done }, !busy));
  });

  if (p === undefined || current === undefined) {
    return <EmptyState icon="folder" title="Not Here" body="The hub doesn't list it any more." />;
  }
  const choose = (next: ProjectIcon) => {
    haptics.select();
    setPick(pickOver(next, p.avatar));
  };
  // A photo chosen is the newer choice: the pick goes, even before the photo's summary arrives.
  const photo = (from: () => Promise<Awaited<ReturnType<typeof fromLibrary>>>) => () =>
    void from().then((got) => {
      if (got === null) return;
      setPick(null);
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

  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <View style={styles.preview} accessible accessibilityRole="image" accessibilityLabel={hasPicture ? "Its photo" : `${faceName(current.face)} in ${colorName(current.color)}`}>
        <Avatar name={p.title} navi={isNavi(p)} size={PREVIEW} picture={p} {...(picked === null ? {} : { icon: picked })} />
      </View>

      <View style={[styles.card, { backgroundColor: t.cell }]} accessibilityRole="radiogroup" accessibilityLabel="Face">
        <View style={styles.faces}>
          {ICON_FACES.map((f) => {
            const on = !hasPicture && f.id === current.face;
            const source = iconSource({ face: f.id, color: current.color }, FACE);
            return (
              <Pressable
                key={f.id}
                accessibilityRole="radio"
                accessibilityLabel={f.name}
                accessibilityState={{ checked: on }}
                onPress={() => choose({ face: f.id, color: current.color })}
                style={({ pressed }) => [styles.face, pressed && styles.pressed]}
              >
                <View style={[styles.ring, { borderColor: on ? t.accent : "transparent" }]}>
                  {source === undefined ? null : <Image source={source} style={styles.faceImage} fadeDuration={0} />}
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: t.cell }]} accessibilityRole="radiogroup" accessibilityLabel="Color">
        <View style={styles.swatches}>
          {ICON_COLORS.map((c) => {
            const on = !hasPicture && c.id === current.color;
            return (
              <View key={c.id} style={styles.swatchCell}>
                <Pressable
                  accessibilityRole="radio"
                  accessibilityLabel={c.name}
                  accessibilityState={{ checked: on }}
                  hitSlop={4}
                  onPress={() => choose({ face: current.face, color: c.id })}
                  style={({ pressed }) => [styles.swatchRing, { borderColor: on ? c.field : "transparent" }, pressed && styles.pressed]}
                >
                  <View style={[styles.swatch, { backgroundColor: c.field }, t.dark && styles.swatchDark]} />
                </Pressable>
              </View>
            );
          })}
        </View>
      </View>

      <ListSection>
        <ListRow icon="photos" title="Choose Photo" onPress={photo(fromLibrary)} chevron={false} />
        <ListRow icon="takePhoto" title="Take Photo" onPress={photo(fromCamera)} chevron={false} />
        {p.avatar === undefined ? null : <ListRow title="Remove Photo" destructive onPress={busy ? () => undefined : remove} chevron={false} />}
      </ListSection>
    </ScrollView>
  );
}

const faceName = (id: IconFace): string => ICON_FACES.find((f) => f.id === id)?.name ?? id;
const colorName = (id: IconColor): string => ICON_COLORS.find((c) => c.id === id)?.name ?? id;

const styles = StyleSheet.create({
  content: { paddingBottom: space.xxl },
  preview: { alignItems: "center", paddingTop: space.lg, paddingBottom: space.sm },
  card: { marginHorizontal: space.lg, marginTop: space.xl, borderRadius: shape.group, borderCurve: "continuous", paddingVertical: space.md, paddingHorizontal: space.sm },
  faces: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-around", rowGap: space.sm },
  face: { width: "33.3%", alignItems: "center" },
  ring: { width: FACE + 10, height: FACE + 10, borderRadius: (FACE + 10) / 2, borderWidth: 2.5, alignItems: "center", justifyContent: "center" },
  faceImage: { width: FACE, height: FACE },
  // Two rows of six.
  swatches: { flexDirection: "row", flexWrap: "wrap", rowGap: space.md },
  swatchCell: { width: `${String(100 / 6)}%`, alignItems: "center" },
  swatchRing: { width: SWATCH + 10, height: SWATCH + 10, borderRadius: (SWATCH + 10) / 2, borderWidth: 2.5, alignItems: "center", justifyContent: "center" },
  swatch: { width: SWATCH, height: SWATCH, borderRadius: SWATCH / 2 },
  // On dark grounds a dark color (Graphite) keeps a light edge.
  swatchDark: { borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.22)" },
  pressed: { transform: [{ scale: 0.94 }] },
});
