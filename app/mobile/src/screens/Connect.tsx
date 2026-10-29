// Pairing (D232): a welcome with the app's mark and two ways in. Scan QR Code opens the camera on the code the hub
// shows (`fleetd pair`, or the desktop app), and a valid one pairs in one step; iOS's Camera opens the same link in
// the app (App.tsx). Enter Code Manually is the hub's address and the code, as the desktop app's connect screen asks;
// a code or a whole pairing link on the clipboard pastes into it.
import { useHeaderHeight } from "@react-navigation/elements";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { BlurView } from "expo-blur";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import * as Device from "expo-device";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { Image, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { normalizeCode, type PairFailure } from "../desktop";
import type { PairParams } from "../hubContext";
import { pair, type Paired } from "../hub/pair";
import { pairLinkStep, parsePairLink } from "../hub/pairLink";
import { mono, space, TOUCH, type, useTheme } from "../theme";
import { Button } from "../ui/Button";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { ListSection } from "../ui/List";

const deviceName = (): string => Device.deviceName ?? (Platform.OS === "ios" ? "iPhone" : "Android phone");

/** What the clipboard holds for pairing: a whole pairing link, or a code ("ABCD-2345", or the line it's printed in). */
const pasted = async (): Promise<{ hub?: string; code: string } | undefined> => {
  try {
    const text = await Clipboard.getStringAsync();
    const link = parsePairLink(text);
    if (link?.ok === true) return { hub: link.hub, code: link.code };
    const match = /\b[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}\b/u.exec(text);
    const code = match === null ? null : normalizeCode(match[0]);
    return code === null ? undefined : { code };
  } catch {
    return undefined;
  }
};

export function Welcome({ navigation, note }: NativeStackScreenProps<PairParams, "Welcome"> & { note: string | undefined }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.welcome, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, space.lg) + space.sm }]}>
      <View style={styles.hero}>
        {/* A hairline edge in dark, where the mark's dark tile would melt into the ground. */}
        <Image source={require("../../assets/icon.png")} style={[styles.mark, t.dark && { borderWidth: StyleSheet.hairlineWidth, borderColor: t.separator }]} accessibilityIgnoresInvertColors />
        <Text style={[type.largeTitle, { color: t.label }]} accessibilityRole="header">
          fleetd
        </Text>
        <Text style={[type.body, styles.center, { color: t.secondary }]}>Your Navis, projects and approvals, from your own hub.</Text>
        {note === undefined ? null : <Text style={[type.subhead, styles.center, { color: t.warning }]}>{note}</Text>}
      </View>
      <View style={styles.actions}>
        <Button label="Scan QR Code" icon="scan" size="large" onPress={() => navigation.navigate("Scan")} />
        <Button label="Enter Code Manually" kind="plain" size="large" onPress={() => navigation.navigate("Pair")} />
        <Text style={[type.footnote, styles.center, styles.hint, { color: t.secondary }]}>
          Your hub shows the code: run <Text style={styles.code}>fleetd pair</Text> on it, or pair from the desktop app.
        </Text>
      </View>
    </View>
  );
}

/** The camera on a pairing QR code: a fleetd link goes on to pair, anything else says why it didn't. */
export function Scan({ navigation }: NativeStackScreenProps<PairParams, "Scan">) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // The camera reports a code many times a second: each is read once, and a wrong one again only after a pause.
  const seen = useRef<{ data: string; at: number } | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (permission?.status === "undetermined") void requestPermission();
  }, [permission?.status, requestPermission]);

  const onScan = ({ data }: BarcodeScanningResult) => {
    const now = Date.now();
    if (done.current || (seen.current?.data === data && now - seen.current.at < 2500)) return;
    seen.current = { data, at: now };
    // The person opened the scanner to pair: a good code pairs at once (a link from outside asks first, App.tsx).
    const step = pairLinkStep(data, "scanner", null);
    if (step.t !== "pair") {
      haptics.warning();
      setProblem(step.t === "refuse" ? step.failure.message : "That isn't a fleetd pairing code.");
      return;
    }
    done.current = true;
    haptics.success();
    navigation.goBack();
    navigation.navigate("Pair", { hub: step.hub, code: step.code, auto: true });
  };

  const denied = permission !== null && !permission.granted && !permission.canAskAgain;
  return (
    <View style={styles.scan}>
      <StatusBar style="light" />
      {permission?.granted === true ? (
        <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScan} />
      ) : null}
      <View style={[styles.scanTop, { paddingTop: insets.top + space.sm }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => navigation.goBack()} hitSlop={8} style={styles.round}>
          <BlurView tint="systemUltraThinMaterialDark" intensity={80} style={StyleSheet.absoluteFill} />
          <Icon name="close" size={17} color="#FFFFFF" weight="semibold" />
        </Pressable>
        <Text style={[type.headline, styles.onCamera]} accessibilityRole="header">
          Scan QR Code
        </Text>
        <View style={styles.round} />
      </View>
      {denied ? (
        <View style={styles.scanMiddle}>
          <Icon name="camera" size={44} color="rgba(255,255,255,0.6)" />
          <Text style={[type.title3, styles.onCamera, styles.center]}>Camera Access Is Off</Text>
          <Text style={[type.subhead, styles.onCameraQuiet, styles.center]}>Allow fleetd to use the camera in Settings to scan your hub's code, or enter the code by hand.</Text>
          <Button label="Open Settings" kind="tinted" size="small" onPress={() => void Linking.openSettings()} />
        </View>
      ) : (
        <View style={styles.scanMiddle} accessibilityLabel="Viewfinder">
          <Viewfinder />
          <View style={[styles.scanNote, problem !== undefined && styles.scanProblem]} accessibilityLiveRegion="polite">
            <Text style={[type.subhead, styles.onCamera, styles.center]}>{problem ?? "Point the camera at the QR code your hub shows."}</Text>
          </View>
        </View>
      )}
      <View style={[styles.scanBottom, { paddingBottom: Math.max(insets.bottom, space.lg) + space.sm }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Enter Code Manually"
          onPress={() => {
            navigation.goBack();
            navigation.navigate("Pair");
          }}
          style={({ pressed }) => [styles.manual, pressed && styles.pressed]}
        >
          <BlurView tint="systemUltraThinMaterialDark" intensity={80} style={StyleSheet.absoluteFill} />
          <Icon name="keyboard" size={17} color="#FFFFFF" />
          <Text style={[type.headline, styles.onCamera]}>Enter Code Manually</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Four corners around where the code goes. */
function Viewfinder() {
  return (
    <View style={styles.finder}>
      {(["tl", "tr", "bl", "br"] as const).map((c) => (
        <View key={c} style={[styles.corner, styles[c]]} />
      ))}
    </View>
  );
}

export function Pair({ route, onPaired }: NativeStackScreenProps<PairParams, "Pair"> & { onPaired: (paired: Paired) => Promise<void> }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const [hub, setHub] = useState(route.params?.hub ?? "");
  const [code, setCode] = useState(route.params?.code ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PairFailure | null>(null);
  const [pasteNote, setPasteNote] = useState<string | undefined>(undefined);
  const codeField = useRef<ComponentRef<typeof TextInput>>(null);
  const ready = hub.trim() !== "" && code.trim() !== "";

  const submit = async (address = hub, typed = code) => {
    if (address.trim() === "" || typed.trim() === "" || busy) return;
    setBusy(true);
    setFailure(null);
    const result = await pair(fetch, address, typed, deviceName());
    // The key kept in the keychain, or it isn't paired: a hub's code works once.
    const failed = result.ok
      ? await onPaired(result.paired).then(
          () => null,
          (): PairFailure => ({ code: "", message: "This phone couldn't keep the hub's key in its keychain.", fix: "Show a new code on the hub and try again." }),
        )
      : result.failure;
    if (failed === null) {
      haptics.success();
      return;
    }
    setBusy(false);
    haptics.warning();
    setFailure(failed);
  };

  // A scanned or opened link pairs at once; a later one (the system Camera, again) fills the form anew.
  const params = route.params;
  useEffect(() => {
    if (params?.hub !== undefined) setHub(params.hub);
    if (params?.code !== undefined) setCode(params.code);
    if (params?.auto === true && params.hub !== undefined && params.code !== undefined) void submit(params.hub, params.code);
    // Only a new link starts this.
  }, [params]);

  const paste = () =>
    void pasted().then((p) => {
      setPasteNote(p === undefined ? "No pairing code on the clipboard." : undefined);
      if (p === undefined) return;
      haptics.select();
      setCode(p.code);
      if (p.hub !== undefined) setHub(p.hub);
    });

  const field = { ...type.body, color: t.label };
  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">
        <Text style={[type.subhead, styles.lead, { color: t.secondary }]}>
          Type the hub's address and the code that <Text style={styles.code}>fleetd pair</Text> or the desktop app shows. On a tailnet, keep Tailscale on.
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
              autoFocus={params?.auto !== true}
              keyboardType="url"
              textContentType="URL"
              returnKeyType="next"
              onSubmitEditing={() => codeField.current?.focus()}
              accessibilityLabel="Hub address"
              keyboardAppearance={t.dark ? "dark" : "light"}
              editable={!busy}
            />
          </View>
        </ListSection>
        <ListSection header="Pairing code" footer={pasteNote ?? "A code works once, for 15 minutes."}>
          <View style={[styles.fieldRow, styles.codeRow]}>
            <TextInput
              ref={codeField}
              style={[field, styles.input, styles.code, styles.grow]}
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
              editable={!busy}
            />
            <Button label="Paste" icon="paste" kind="tinted" size="small" disabled={busy} onPress={paste} />
          </View>
        </ListSection>
        {failure === null ? null : (
          <View style={[styles.failure, { backgroundColor: t.dangerSoft }]} accessibilityLiveRegion="polite">
            <Icon name="error" size={20} color={t.danger} />
            <View style={styles.grow}>
              <Text style={[type.subhead, styles.strong, { color: t.label }]}>{failure.message}</Text>
              {failure.fix === undefined ? null : <Text style={[type.footnote, { color: t.secondary }]}>{failure.fix.replace(/`/gu, "")}</Text>}
            </View>
          </View>
        )}
        <View style={styles.submit}>
          <Button label={busy ? "Connecting…" : "Connect"} size="large" busy={busy} disabled={!ready} onPress={() => void submit()} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const CORNER = 34;
const LINE = 4;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1 },
  strong: { fontWeight: "600" },
  welcome: { flex: 1, paddingHorizontal: space.xl },
  hero: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md },
  mark: { width: 100, height: 100, borderRadius: 23, borderCurve: "continuous", marginBottom: space.sm },
  center: { textAlign: "center", maxWidth: 320 },
  actions: { gap: space.xs, alignItems: "stretch" },
  hint: { alignSelf: "center", marginTop: space.sm },
  lead: { paddingHorizontal: space.xl, paddingTop: space.sm, textAlign: "center" },
  code: { fontFamily: mono },
  fieldRow: { minHeight: TOUCH, justifyContent: "center", paddingHorizontal: space.lg },
  codeRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingRight: space.sm + 2 },
  input: { paddingVertical: 11 },
  failure: { flexDirection: "row", gap: space.md, marginHorizontal: space.lg, marginTop: space.lg, padding: space.md + 2, borderRadius: 16, borderCurve: "continuous" },
  submit: { marginHorizontal: space.lg, marginTop: space.xl },
  scan: { flex: 1, backgroundColor: "#000000" },
  scanTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.lg },
  round: { width: TOUCH, height: TOUCH, borderRadius: TOUCH / 2, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  onCamera: { color: "#FFFFFF" },
  onCameraQuiet: { color: "rgba(255,255,255,0.7)" },
  scanMiddle: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.lg, paddingHorizontal: space.xxl },
  scanNote: { paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: 18, maxWidth: 320 },
  scanProblem: { backgroundColor: "rgba(255,59,48,0.85)" },
  scanBottom: { alignItems: "center" },
  manual: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 50, paddingHorizontal: space.xl, borderRadius: 25, overflow: "hidden" },
  pressed: { opacity: 0.7 },
  finder: { width: 250, height: 250 },
  corner: { position: "absolute", width: CORNER, height: CORNER, borderColor: "#FFFFFF" },
  tl: { top: 0, left: 0, borderTopWidth: LINE, borderLeftWidth: LINE, borderTopLeftRadius: 18 },
  tr: { top: 0, right: 0, borderTopWidth: LINE, borderRightWidth: LINE, borderTopRightRadius: 18 },
  bl: { bottom: 0, left: 0, borderBottomWidth: LINE, borderLeftWidth: LINE, borderBottomLeftRadius: 18 },
  br: { bottom: 0, right: 0, borderBottomWidth: LINE, borderRightWidth: LINE, borderBottomRightRadius: 18 },
});
