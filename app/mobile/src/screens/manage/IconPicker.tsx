// A project's icon, from its screen (Info): a sheet with its bot or photo large at the top, and Choose Photo / Take
// Photo (then Move and Scale) / Remove Photo, as the desktop's Settings › Projects › Icon. Every project without a
// photo wears the same bot, whose motion shows what it's doing, so there is nothing else to pick.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useHub, type RootParams } from "../../hubContext";
import { space, useTheme } from "../../theme";
import { Avatar } from "../../ui/Avatar";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { useBot } from "../../ui/botState";
import { removePicture } from "./api";
import { errorWords, sheetOptions } from "./parts";
import { fromCamera, fromLibrary } from "./pick";

const PREVIEW = 112;

export function IconPicker({ navigation, route }: NativeStackScreenProps<RootParams, "Icon">) {
  const t = useTheme();
  const { state, session } = useHub();
  const key = route.params.key;
  const p = state.projects?.[key];
  const bot = useBot(key);
  const [busy, setBusy] = useState(false);
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

  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <View style={styles.preview} accessible accessibilityRole="image" accessibilityLabel={p.avatar === undefined ? "Its bot" : "Its photo"}>
        <Avatar name={p.title} size={PREVIEW} picture={p} bot={bot} />
      </View>
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
});
