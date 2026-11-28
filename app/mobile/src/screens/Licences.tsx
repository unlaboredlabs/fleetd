// Settings › Open Source Licences: what the app is built from (notices.json, scripts/notices.ts), as iOS's own Legal
// pages list it. Each package by name, its version and licence; a tap shows its licence text whole (Licence). The native
// libraries React Native builds in carry no text here: a tap opens their source, where theirs is.
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import type { SettingsProps } from "../hubContext";
import notices from "../notices.json";
import { shape, space, type, useTheme } from "../theme";
import { Icon } from "../ui/Icon";
import { ListRow, ListSection } from "../ui/List";

export function Licences({ navigation }: SettingsProps<"Licences">) {
  const t = useTheme();
  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }}>
      <ListSection header="Packages" footer="fleetd itself is under the MIT licence.">
        {notices.packages.map((p) => (
          <ListRow key={p.name} title={p.name} detail={`${p.version} · ${p.license || "Licence not stated"}`} onPress={() => navigation.navigate("Licence", { name: p.name })} />
        ))}
      </ListSection>
      <ListSection header="Built into React Native">
        {notices.native.map((l) => (
          <ListRow
            key={l.name}
            title={l.name}
            detail={l.license}
            onPress={() => void Linking.openURL(l.url)}
            accessory={<Icon name="external" size={14} color={t.tertiary} />}
            chevron={false}
          />
        ))}
      </ListSection>
    </ScrollView>
  );
}

/** One package's licence text, as it ships it. */
export function Licence({ route }: SettingsProps<"Licence">) {
  const t = useTheme();
  const p = notices.packages.find((x) => x.name === route.params.name);
  const text = p === undefined ? undefined : notices.texts[p.text];
  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.page}>
      <View style={[styles.card, { backgroundColor: t.cell }]}>
        <Text style={[type.footnote, { color: t.label }]} selectable>
          {text ?? `${route.params.name} ships no licence text of its own. It is under the ${p?.license || "licence its authors state"}.`}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.lg, paddingBottom: space.xxl },
  card: { borderRadius: shape.group, borderCurve: "continuous", padding: space.lg },
});
