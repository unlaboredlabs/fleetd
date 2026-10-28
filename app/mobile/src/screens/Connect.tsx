// Pairing: the hub's address and a code from `fleetd pair` on the hub, as the desktop app's connect screen asks.
import * as Device from "expo-device";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { PairFailure } from "../desktop";
import { pair, type Paired } from "../hub/pair";
import { color, mono, size } from "../theme";
import { Button } from "../ui";

const deviceName = (): string => Device.deviceName ?? (Platform.OS === "ios" ? "iPhone" : "Android phone");

export function Connect({ onPaired, note }: { onPaired: (paired: Paired) => void; note?: string | undefined }) {
  const [hub, setHub] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PairFailure | null>(null);

  const submit = async () => {
    setBusy(true);
    setFailure(null);
    const result = await pair(fetch, hub, code, deviceName());
    setBusy(false);
    if (result.ok) onPaired(result.paired);
    else setFailure(result.failure);
  };

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.headline}>Connect to your hub</Text>
        <Text style={styles.prose}>
          On the hub, run <Text style={styles.code}>fleetd pair</Text> and type the code it prints. On a tailnet, keep Tailscale on.
        </Text>
        {note === undefined ? null : <Text style={[styles.prose, { color: color.warning }]}>{note}</Text>}
        <Text style={styles.label}>Hub address</Text>
        <TextInput
          style={styles.input}
          value={hub}
          onChangeText={setHub}
          placeholder="http://devbox:4790"
          placeholderTextColor={color.faint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
        />
        <Text style={styles.label}>Pairing code</Text>
        <TextInput
          style={[styles.input, styles.code]}
          value={code}
          onChangeText={setCode}
          placeholder="ABCD-2345"
          placeholderTextColor={color.faint}
          autoCapitalize="characters"
          autoCorrect={false}
          onSubmitEditing={() => void submit()}
        />
        {failure === null ? null : (
          <View style={styles.failure}>
            <Text style={styles.failureText}>{failure.message}</Text>
            {failure.fix === undefined ? null : <Text style={styles.prose}>{failure.fix}</Text>}
          </View>
        )}
        <Button label={busy ? "Pairing…" : "Pair"} tone="accent" disabled={busy || hub.trim() === "" || code.trim() === ""} onPress={() => void submit()} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 20, gap: 8 },
  headline: { color: color.text, fontSize: 20, fontWeight: "600", marginTop: 24, marginBottom: 4 },
  prose: { color: color.quiet, fontSize: size.sm, lineHeight: 19 },
  code: { fontFamily: mono },
  label: { color: color.quiet, fontSize: size.xs, marginTop: 12 },
  input: {
    color: color.text,
    fontSize: size.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: color.raised,
  },
  failure: { marginVertical: 8, gap: 4 },
  failureText: { color: color.danger, fontSize: size.sm },
});
