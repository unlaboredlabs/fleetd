// fleetd cloud on the phone (decision hosted.first-screen, artifact hosted-signin-design): the first screen's two ways
// in, a line each, Sign In and Use Your Own Hub; Where Agents Run, the chats list of a team with nothing to run agents on yet;
// and in Settings, the hubs this phone keeps with a tap to switch, and the fleetd account with Sign In or Sign Out.
// Only a build given the cloud's two values (cloud/config.ts) shows any of it; any other is the self-hosted app alone.
// Back from the sign-in page, iOS's own alerts name the account ("Signed in as <email>", Sign Out or Continue), then
// ask about each invitation, Join or Not Now, before anything pairs (decision hosted.invites-need-accept). Under the two
// ways, a quiet Sign in with a review code opens App Review's way in (D737): the demo address and its fixed code, sent
// in place of the page, then the same questions and pairing.
import { getRandomBytes } from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import { Alert, AppState, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { signInAsking, type AfterSignInAsk, type SignInOutcome, type SignInPorts, type TeamOutcome } from "../cloud/account";
import { builtCloudConfig, type CloudConfig } from "../cloud/config";
import { invitationLine, invitationTitle, type PairFailure } from "../desktop";
import { deviceName } from "../hub/deviceName";
import { useHub } from "../hubContext";
import { COLUMN, space, TOUCH, type, useTheme } from "../theme";
import { useAnnounce } from "../ui/announce";
import { Button } from "../ui/Button";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { ListRow, ListSection } from "../ui/List";
import { EmptyState } from "../ui/States";

/** This bundle's cloud values, read once: null on a build without them, which shows nothing of fleetd cloud. */
export const cloud: CloudConfig | null = builtCloudConfig();

/** The two ways in, and what each means in a line: the desktop's words (onboarding/SignIn.tsx WAYS). */
export const WAYS = {
  signIn: { name: "Sign In", line: "fleetd hosts your workspace. Agents run on fleetd's computers or your own." },
  own: { name: "Use Your Own Workspace", line: "A workspace you run yourself. No fleetd account." },
} as const;

const ports = (config: CloudConfig): SignInPorts => ({
  config,
  local: typeof __DEV__ !== "undefined" && __DEV__,
  fetch,
  // iOS's ASWebAuthenticationSession, Android's Custom Tab: the system's own sign-in sheet, never a web view of ours.
  authSession: (url, redirect) => WebBrowser.openAuthSessionAsync(url, redirect),
  random: getRandomBytes,
  deviceName: deviceName(),
});

/** The questions after the page, as iOS's alerts: neither can be dismissed without an answer. */
const alertAsk: AfterSignInAsk = {
  signedInAs: (email) =>
    new Promise((resolve) =>
      Alert.alert(`Signed in as ${email}`, "Not you? Sign out.", [
        { text: "Sign Out", style: "destructive", onPress: () => resolve(false) },
        { text: "Continue", style: "default", isPreferred: true, onPress: () => resolve(true) },
      ], { cancelable: false }),
    ),
  invitation: (invitation) =>
    new Promise((resolve) =>
      Alert.alert(invitationTitle(invitation), invitationLine(invitation), [
        { text: "Not Now", style: "cancel", onPress: () => resolve(false) },
        { text: "Join", onPress: () => resolve(true) },
      ], { cancelable: false }),
    ),
  makeTeam: (email) =>
    new Promise((resolve) =>
      Alert.alert("No Workspace Yet", `Make one of your own for ${email}, or ask a teammate to invite this email.`, [
        { text: "Not Now", style: "cancel", onPress: () => resolve(false) },
        { text: "Make a Workspace", isPreferred: true, onPress: () => resolve(true) },
      ], { cancelable: false }),
    ),
};

/** A signed-in account's outcome, for the app to keep its teams' keys; a failure there is the keychain's. */
export type OnSignedIn = (out: SignInOutcome & { ok: true }) => Promise<void>;

/** Teams the last sign-in couldn't connect, which the account's section says until the next one. */
let missed: ReadonlyArray<TeamOutcome & { ok: false }> = [];

/** One sign-in at a time: Sign In opens the system's sheet and waits; it ends kept, closed, or with why not. */
export function useSignIn(onSignedIn: OnSignedIn) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<PairFailure | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useAnnounce(note?.message);
  /** Signs in on WorkOS's page, or with `review`'s address and code (App Review's way in). */
  const start = useCallback((review?: { email: string; code: string }) => {
    if (cloud === null || running.current) return;
    running.current = true;
    haptics.tap();
    setBusy(true);
    setNote(null);
    void signInAsking(ports(cloud), alertAsk, review)
      .then(async (out): Promise<PairFailure | null> => {
        if (!out.ok) return out.cancelled === true ? null : out.failure;
        missed = out.teams.filter((t): t is TeamOutcome & { ok: false } => !t.ok);
        return onSignedIn(out).then(
          () => null,
          (): PairFailure => ({ code: "", message: "This phone couldn't keep your workspace's key in its keychain.", fix: "Sign in again." }),
        );
      })
      .then((failure) => {
        running.current = false;
        if (failure === null) haptics.success();
        else haptics.warning();
        if (!mounted.current) return;
        setBusy(false);
        setNote(failure);
      });
  }, [onSignedIn]);
  return { busy, note, start };
}

/** Why the last sign-in ended without connecting, in the pairing form's box. */
function Failure({ failure }: { failure: PairFailure }) {
  const t = useTheme();
  return (
    <View style={[styles.failure, { backgroundColor: t.dangerSoft }]} accessibilityLiveRegion="polite">
      <Icon name="error" size={20} color={t.danger} />
      <View style={styles.grow}>
        <Text style={[type.subhead, styles.strong, { color: t.label }]}>{failure.message}</Text>
        {failure.fix === undefined ? null : <Text style={[type.footnote, { color: t.secondary }]}>{failure.fix}</Text>}
      </View>
    </View>
  );
}

/** The first screen's two ways in, each a full-width button and its line: your own hub is no small link under the other. */
export function Ways({ onOwn, onReview, onSignedIn }: { onOwn: () => void; onReview: () => void; onSignedIn: OnSignedIn }) {
  const t = useTheme();
  const { busy, note, start } = useSignIn(onSignedIn);
  return (
    <View style={styles.ways}>
      {note === null ? null : <Failure failure={note} />}
      <View style={styles.way}>
        <Button label={busy ? "Signing In…" : note === null ? WAYS.signIn.name : "Sign In Again"} size="large" busy={busy} onPress={() => start()} />
        <Text style={[type.footnote, styles.center, { color: t.secondary }]}>{WAYS.signIn.line}</Text>
      </View>
      <View style={styles.way}>
        <Button label={WAYS.own.name} kind="tinted" size="large" disabled={busy} onPress={onOwn} />
        <Text style={[type.footnote, styles.center, { color: t.secondary }]}>{WAYS.own.line}</Text>
      </View>
      <Text style={[type.footnote, styles.review, { color: t.tertiary }]} accessibilityRole="link" onPress={busy ? undefined : onReview} suppressHighlighting={false}>
        Sign in with a review code
      </Text>
    </View>
  );
}

/** App Review's way in: the demo address and its code, then the same questions and pairing as Sign In's. */
export function ReviewSignIn({ onSignedIn }: { onSignedIn: OnSignedIn }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { busy, note, start } = useSignIn(onSignedIn);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const codeField = useRef<ComponentRef<typeof TextInput>>(null);
  const ready = email.trim() !== "" && code.trim() !== "" && !busy;
  const submit = () => {
    if (ready) start({ email, code });
  };
  const field = [type.body, styles.input, { color: t.label }];
  const common = { selectionColor: t.accent, placeholderTextColor: t.tertiary, autoCapitalize: "none", autoCorrect: false, keyboardAppearance: t.dark ? "dark" : "light", editable: !busy } as const;
  return (
    <KeyboardAvoidingView style={styles.grow} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
      <ScrollView contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + space.xl }]} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">
        <ListSection header="Email">
          <View style={styles.fieldRow}>
            <TextInput
              {...common}
              style={field}
              value={email}
              onChangeText={setEmail}
              placeholder="review@example.com"
              autoFocus
              keyboardType="email-address"
              textContentType="username"
              returnKeyType="next"
              onSubmitEditing={() => codeField.current?.focus()}
              accessibilityLabel="Email"
            />
          </View>
        </ListSection>
        <ListSection header="Code">
          <View style={styles.fieldRow}>
            <TextInput
              {...common}
              ref={codeField}
              style={field}
              value={code}
              onChangeText={setCode}
              placeholder="Review code"
              textContentType="oneTimeCode"
              returnKeyType="go"
              onSubmitEditing={submit}
              accessibilityLabel="Code"
            />
          </View>
        </ListSection>
        {note === null ? null : (
          <View style={styles.formFailure}>
            <Failure failure={note} />
          </View>
        )}
        <View style={styles.submit}>
          <Button label={busy ? "Signing In…" : "Sign In"} size="large" busy={busy} disabled={!ready} onPress={submit} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/**
 * The chats list of a team with nothing to run agents on (no computer, no hosted provider): the phone runs no join
 * line or key's sealed field, so it says where either is set up (the desktop's setup/ConnectComputer.tsx). Refresh reads the hub again, and so does coming back to the app.
 */
export function ConnectComputer() {
  const { session } = useHub();
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") session.refresh();
    });
    return () => sub.remove();
  }, [session]);
  return (
    <EmptyState
      icon="desktop"
      title="Where Agents Run"
      body="On a computer of yours. Connect one from the desktop app or the web app."
      action={{
        label: "Refresh",
        onPress: () => {
          haptics.tap();
          session.refresh();
        },
      }}
    />
  );
}

/**
 * Settings' hubs and fleetd account: every hub this phone keeps, the one shown checked, a tap on another to switch
 * (its notifications come only from the one shown); then who is signed in, with Sign Out, or Sign In. Only a build
 * with the cloud's values shows the account, and only a phone with more than one hub the list.
 */
export function CloudSettings() {
  const t = useTheme();
  const { paired, hubs, account, switchTo, signedIn, signOutCloud } = useHub();
  const { busy, note, start } = useSignIn(signedIn);
  const [leaving, setLeaving] = useState(false);
  const signOut = () => {
    setLeaving(true);
    void signOutCloud().finally(() => setLeaving(false));
  };
  const teams = hubs.filter((h) => h.cloud === true);
  const late = account === null ? [] : missed;
  return (
    <>
      {hubs.length < 2 ? null : (
        <ListSection header="Hubs" footer="Notifications come from the hub shown.">
          {hubs.map((h) => (
            <ListRow
              key={h.hub}
              title={h.hubName}
              {...(h.hub === paired.hub ? { accessory: <Icon name="done" size={17} color={t.accent} weight="semibold" /> } : { onPress: () => switchTo(h) })}
              chevron={false}
            />
          ))}
        </ListSection>
      )}
      {cloud === null ? null : account === null ? (
        <ListSection header="fleetd account" footer={note === null ? WAYS.signIn.line : `${note.message} ${note.fix ?? ""}`.trim()}>
          <ListRow title={busy ? "Signing In…" : "Sign In"} {...(busy ? {} : { onPress: () => start() })} chevron={false} />
        </ListSection>
      ) : (
        <ListSection
          header="fleetd account"
          footer={[teams.length === 0 ? "" : `Signs this phone out of ${teams.map((h) => h.hubName).join(", ")}.`, ...late.map((m) => `${m.failure.message} ${m.failure.fix ?? ""}`.trim())].filter((l) => l !== "").join(" ")}
        >
          <ListRow title="Email" value={account.email} selectable />
          <ListRow title={leaving ? "Signing Out…" : "Sign Out"} destructive {...(leaving ? {} : { onPress: signOut })} chevron={false} />
        </ListSection>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  strong: { fontWeight: "600" },
  center: { textAlign: "center", alignSelf: "center", maxWidth: 320 },
  ways: { gap: space.lg, alignItems: "stretch", alignSelf: "center", width: "100%", maxWidth: COLUMN },
  way: { gap: space.sm },
  review: { textAlign: "center", alignSelf: "center", paddingVertical: space.xs },
  form: { alignSelf: "center", width: "100%", maxWidth: COLUMN },
  fieldRow: { minHeight: TOUCH, justifyContent: "center", paddingHorizontal: space.lg },
  input: { paddingVertical: 11 },
  formFailure: { marginHorizontal: space.lg, marginTop: space.lg },
  submit: { marginHorizontal: space.lg, marginTop: space.xl },
  failure: { flexDirection: "row", gap: space.md, padding: space.md + 2, borderRadius: 16, borderCurve: "continuous" },
});
