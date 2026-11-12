// fleetd cloud on the phone (decision hosted.first-screen, artifact hosted-signin-design): the first screen's two ways
// in, a line each, Sign In and Use Your Own Hub; Connect a Computer, the chats list of a team with no computer yet;
// and in Settings, the hubs this phone keeps with a tap to switch, and the fleetd account with Sign In or Sign Out.
// Only a build given the cloud's two values (cloud/config.ts) shows any of it; any other is the self-hosted app alone.
// Back from the sign-in page, iOS's own alerts name the account ("Signed in as <email>", Sign Out or Continue), then
// ask about each invitation, Join or Not Now, before anything pairs (decision hosted.invites-need-accept).
import { getRandomBytes } from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, StyleSheet, Text, View } from "react-native";
import { signInAsking, type AfterSignInAsk, type SignInOutcome, type SignInPorts, type TeamOutcome } from "../cloud/account";
import { builtCloudConfig, type CloudConfig } from "../cloud/config";
import { invitationLine, invitationTitle, type PairFailure } from "../desktop";
import { deviceName } from "../hub/deviceName";
import { useHub } from "../hubContext";
import { space, type, useTheme } from "../theme";
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
  signIn: { name: "Sign In", line: "fleetd hosts your hub. Your agents run on your own computers." },
  own: { name: "Use Your Own Hub", line: "A hub you run yourself. No fleetd account." },
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
  const start = useCallback(() => {
    if (cloud === null || running.current) return;
    running.current = true;
    haptics.tap();
    setBusy(true);
    setNote(null);
    void signInAsking(ports(cloud), alertAsk)
      .then(async (out): Promise<PairFailure | null> => {
        if (!out.ok) return out.cancelled === true ? null : out.failure;
        missed = out.teams.filter((t): t is TeamOutcome & { ok: false } => !t.ok);
        return onSignedIn(out).then(
          () => null,
          (): PairFailure => ({ code: "", message: "This phone couldn't keep your team's key in its keychain.", fix: "Sign in again." }),
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
export function Ways({ onOwn, onSignedIn }: { onOwn: () => void; onSignedIn: OnSignedIn }) {
  const t = useTheme();
  const { busy, note, start } = useSignIn(onSignedIn);
  return (
    <View style={styles.ways}>
      {note === null ? null : <Failure failure={note} />}
      <View style={styles.way}>
        <Button label={busy ? "Signing In…" : note === null ? WAYS.signIn.name : "Sign In Again"} size="large" busy={busy} onPress={start} />
        <Text style={[type.footnote, styles.center, { color: t.secondary }]}>{WAYS.signIn.line}</Text>
      </View>
      <View style={styles.way}>
        <Button label={WAYS.own.name} kind="tinted" size="large" disabled={busy} onPress={onOwn} />
        <Text style={[type.footnote, styles.center, { color: t.secondary }]}>{WAYS.own.line}</Text>
      </View>
    </View>
  );
}

/**
 * The chats list of a team with no computer: the phone runs no join line, so it says where one joins, the desktop
 * app's words (setup/ConnectComputer.tsx). Refresh reads the hub again, and so does coming back to the app.
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
      title="Connect a Computer"
      body="Your agents run on it, with its Claude login and your code. fleetd hosts only the hub. Choose Connect this computer in the desktop app, or paste its join line in a terminal on that computer."
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
          <ListRow title={busy ? "Signing In…" : "Sign In"} {...(busy ? {} : { onPress: start })} chevron={false} />
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
  ways: { gap: space.lg, alignItems: "stretch" },
  way: { gap: space.sm },
  failure: { flexDirection: "row", gap: space.md, padding: space.md + 2, borderRadius: 16, borderCurve: "continuous" },
});
