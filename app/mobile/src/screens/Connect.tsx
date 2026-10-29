// Pairing: a welcome with the app's mark and one way in, then the hub's address and a code from `fleetd pair` on the
// hub, as the desktop app's connect screen asks. A code on the clipboard can be pasted straight in.
import { useHeaderHeight } from "@react-navigation/elements";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import * as Device from "expo-device";
import { useRef, useState, type ComponentRef } from "react";
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { normalizeCode, type PairFailure } from "../desktop";
import type { PairParams } from "../hubContext";
import { pair, type Paired } from "../hub/pair";
import { mono, space, TOUCH, type, useTheme } from "../theme";
import { Button } from "../ui/Button";
import { haptics } from "../ui/haptics";
import { ListSection } from "../ui/List";

const deviceName = (): string => Device.deviceName ?? (Platform.OS === "ios" ? "iPhone" : "Android phone");

/** The clipboard's pairing code, if it holds one ("ABCD-2345", or the line `fleetd pair` prints it in). */
const pastedCode = async (): Promise<string | undefined> => {
  try {
    const text = await Clipboard.getStringAsync();
    const match = /\b[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}\b/u.exec(text);
    return match === null ? undefined : (normalizeCode(match[0]) ?? undefined);
  } catch {
    return undefined;
  }
};

export function Welcome({ navigation, note }: NativeStackScreenProps<PairParams, "Welcome"> & { note: string | undefined }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [pasteNote, setPasteNote] = useState<string | undefined>(undefined);
  return (
    <View style={[styles.welcome, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, space.lg) + space.sm }]}>
      <View style={styles.hero}>
        <Image source={require("../../assets/icon.png")} style={styles.mark} accessibilityIgnoresInvertColors />
        <Text style={[type.largeTitle, { color: t.label }]} accessibilityRole="header">
          fleetd
        </Text>
        <Text style={[type.body, styles.center, { color: t.secondary }]}>Your Navis, projects and approvals, from your own hub.</Text>
        {note === undefined ? null : <Text style={[type.subhead, styles.center, { color: t.warning }]}>{note}</Text>}
      </View>
      <View style={styles.actions}>
        <Button label="Connect to a Hub" size="large" onPress={() => navigation.navigate("Pair")} />
        <Button
          label="Paste a Pairing Code"
          kind="plain"
          icon="paste"
          onPress={() =>
            void pastedCode().then((code) => {
              setPasteNote(code === undefined ? "No pairing code on the clipboard. Run fleetd pair on the hub and copy the code it prints." : undefined);
              if (code !== undefined) navigation.navigate("Pair", { code });
            })
          }
        />
        {pasteNote === undefined ? null : <Text style={[type.footnote, styles.center, { color: t.secondary }]}>{pasteNote}</Text>}
      </View>
    </View>
  );
}

export function Pair({ route, onPaired }: NativeStackScreenProps<PairParams, "Pair"> & { onPaired: (paired: Paired) => Promise<void> }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const [hub, setHub] = useState("");
  const [code, setCode] = useState(route.params?.code ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PairFailure | null>(null);
  const codeField = useRef<ComponentRef<typeof TextInput>>(null);
  const ready = hub.trim() !== "" && code.trim() !== "";

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setFailure(null);
    const result = await pair(fetch, hub, code, deviceName());
    // The key kept in the keychain, or it isn't paired: a hub's code works once.
    const failure = result.ok
      ? await onPaired(result.paired).then(
          () => null,
          (): PairFailure => ({ code: "", message: "This phone couldn't keep the hub's key in its keychain.", fix: "Run fleetd pair on the hub again and type the new code." }),
        )
      : result.failure;
    if (failure === null) {
      haptics.success();
      return;
    }
    setBusy(false);
    haptics.warning();
    setFailure(failure);
  };

  const field = { ...type.body, color: t.label };
  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">
        <Text style={[type.subhead, styles.lead, { color: t.secondary }]}>
          On the hub, run <Text style={styles.code}>fleetd pair</Text> and type the code it prints. On a tailnet, keep Tailscale on.
        </Text>
        <ListSection header="Hub address">
          <View style={styles.fieldRow}>
            <TextInput
              style={[field, styles.input]}
              value={hub}
              onChangeText={setHub}
              placeholder="http://devbox:4790"
              placeholderTextColor={t.tertiary}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus={route.params?.code !== undefined}
              keyboardType="url"
              textContentType="URL"
              returnKeyType="next"
              onSubmitEditing={() => codeField.current?.focus()}
              accessibilityLabel="Hub address"
              keyboardAppearance={t.dark ? "dark" : "light"}
            />
          </View>
        </ListSection>
        <ListSection header="Pairing code" footer="A code works once, for a few minutes.">
          <View style={styles.fieldRow}>
            <TextInput
              ref={codeField}
              style={[field, styles.input, styles.code]}
              value={code}
              onChangeText={setCode}
              placeholder="ABCD-2345"
              placeholderTextColor={t.tertiary}
              autoCapitalize="characters"
              autoCorrect={false}
              textContentType="oneTimeCode"
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
              accessibilityLabel="Pairing code"
              keyboardAppearance={t.dark ? "dark" : "light"}
            />
          </View>
        </ListSection>
        {failure === null ? null : (
          <View style={styles.failure} accessibilityLiveRegion="polite">
            <Text style={[type.subhead, { color: t.danger }]}>{failure.message}</Text>
            {failure.fix === undefined ? null : <Text style={[type.footnote, { color: t.secondary }]}>{failure.fix}</Text>}
          </View>
        )}
        <View style={styles.submit}>
          <Button label="Connect" size="large" busy={busy} disabled={!ready} onPress={() => void submit()} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  welcome: { flex: 1, paddingHorizontal: space.xl },
  hero: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md },
  mark: { width: 96, height: 96, borderRadius: 22, marginBottom: space.sm },
  center: { textAlign: "center", maxWidth: 320 },
  actions: { gap: space.sm, alignItems: "stretch" },
  lead: { paddingHorizontal: space.xxl, paddingTop: space.sm, textAlign: "center" },
  code: { fontFamily: mono },
  fieldRow: { minHeight: TOUCH, justifyContent: "center", paddingHorizontal: space.lg },
  input: { paddingVertical: 11 },
  failure: { gap: space.xs, marginHorizontal: space.xxl, marginTop: space.md },
  submit: { marginHorizontal: space.lg, marginTop: space.xl },
});
