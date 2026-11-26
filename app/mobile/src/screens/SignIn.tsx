// A sign-in form in a chat (request_sign_in): a card naming the site, and the native sheet it opens with the email or
// username, the password with a show toggle (or the code the site sent), "Securely save to Vault" on by default, and
// Submit. What is typed is sealed on the phone to the workspace's own key and goes with secret_submit; the workspace
// fills it into the agent's page and, saved, keeps the login in the team vault for that site. It never enters the chat.
import { type ComponentRef, useRef, useState } from "react";
import { Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type TextInputProps } from "react-native";
import type { SecretRequestItem, SignInField } from "../desktop";
import { useHub } from "../hubContext";
import { shape, space, type, useTheme } from "../theme";
import { Button } from "../ui/Button";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { PRESSED_OPACITY } from "../ui/motion";
import { ListSection } from "../ui/List";
import { SheetRoom } from "../ui/StripRoom";
import { errorWords } from "./manage/parts";
import { codeOnly, signInAsks, signInOutcome } from "./signInModel";
import { sealToHub } from "./vault/api";

/** How long the emptied fields stay before the sheet closes, so iOS sees them empty. */
const CLEAR_MS = 150;

const WORDS: Record<SignInField, string> = { username: "Email or username", password: "Password", otp: "Code" };

export function SignInCard({ item }: { item: SecretRequestItem }) {
  const t = useTheme();
  const { state, session } = useHub();
  const input = item.secureInput;
  const signIn = input?.signIn;
  // Open while the hub lists it open; answered elsewhere, it is gone from that list.
  const listed = state.requests?.find((r) => r.requestId === item.requestId);
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | undefined>(undefined);
  // Filled, the card folds only once its sheet has gone: unmounted with a typed password in it, the sheet would make
  // iOS offer to save that password to the person's own keychain.
  const filled = useRef<string | undefined>(undefined);
  if (input === undefined || signIn === undefined) return null;
  const code = codeOnly(signIn.fields);
  const settled = done ?? (item.state === "stored" ? signInOutcome(signIn.fields, signIn.saved !== undefined) : listed === undefined && state.requests !== undefined ? "Answered" : undefined);
  if (settled !== undefined) {
    return (
      <View style={styles.outcome} accessible accessibilityLabel={`${settled}, ${input.label}`}>
        <Icon name="check" size={13} color={t.success} />
        <Text style={[type.footnote, styles.outcomeText, { color: t.secondary }]} numberOfLines={1}>
          {settled} · {input.label}
        </Text>
      </View>
    );
  }
  const sealTo = item.sealTo;
  const submit = async (values: Partial<Record<SignInField, string>>, save: boolean): Promise<string | undefined> => {
    if (sealTo === undefined) return "This workspace can't take a sign-in form yet. Update fleetd on the workspace's machine.";
    const sealed = sealToHub(values, sealTo);
    if (sealed === null) return "The workspace's key didn't come through. Try again.";
    const r = await session.call("secret_submit", { requestId: item.requestId, sealed, save: save && !code });
    if (!r.ok) return r.error.code === "invalid" ? "Not filled in: the page may have moved on. Try again, or tell the agent in the chat." : errorWords(r.error);
    const next = (r.output as { next?: unknown }).next;
    filled.current = signInOutcome(signIn.fields, typeof next === "string" && next.includes("saved to the vault as"));
    // Android's Modal has no onDismiss: it folds as the sheet closes.
    if (Platform.OS !== "ios") setDone(filled.current);
    return undefined;
  };
  const openForm = () => {
    haptics.tap();
    setOpen(true);
  };
  // As a screen's card beside it (ScreenCards.tsx): a tile, the title and a line, a pill; the whole card opens the form.
  return (
    <View style={styles.cards}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${input.label}. ${input.site.domain}`}
        accessibilityHint={code ? "Opens a secure form for the code" : "Opens a secure form"}
        accessibilityState={{ disabled: sealTo === undefined }}
        disabled={sealTo === undefined}
        onPress={openForm}
        style={({ pressed }) => [styles.card, { backgroundColor: t.surface }, pressed && styles.pressed]}
      >
        <View style={[styles.tile, { backgroundColor: t.accentDeep }]}>
          <Icon name="credential" size={20} color="#FFFFFF" weight="semibold" />
        </View>
        <View style={styles.grow}>
          <Text style={[type.subhead, styles.strong, { color: t.label }]} numberOfLines={1}>
            {input.label}
          </Text>
          <Text style={[type.footnote, { color: t.secondary }]} numberOfLines={2}>
            {input.site.domain} · {code ? "Asks for the code it sent you" : "Opens a secure form"}
          </Text>
          {sealTo === undefined ? <Text style={[type.footnote, { color: t.warning }]}>Update fleetd on the workspace's machine to fill this in here.</Text> : null}
        </View>
        <View style={[styles.button, { backgroundColor: t.fillQuiet }]}>
          <Text style={[type.subhead, styles.strong, { color: t.accent }]}>Open</Text>
        </View>
      </Pressable>
      <SignInSheet visible={open} title={input.label} domain={input.site.domain} why={input.why} asks={signInAsks(signIn.fields)} code={code} onClose={() => setOpen(false)} onDismissed={() => filled.current !== undefined && setDone(filled.current)} onSubmit={submit} />
    </View>
  );
}

/** The form, as an iOS sheet: the fields, the vault switch, Submit. Closed, what was typed goes with it. */
function SignInSheet(props: {
  visible: boolean;
  title: string;
  domain: string;
  why: string;
  asks: SignInField[];
  code: boolean;
  onClose: () => void;
  /** iOS: the sheet has gone. */
  onDismissed: () => void;
  onSubmit: (values: Partial<Record<SignInField, string>>, save: boolean) => Promise<string | undefined>;
}) {
  const t = useTheme();
  const [values, setValues] = useState<Partial<Record<SignInField, string>>>({});
  const [shown, setShown] = useState(false);
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const ready = props.asks.every((f) => (values[f] ?? "").trim() !== "");
  const inputs = useRef(new Map<SignInField, ComponentRef<typeof TextInput>>());
  // iOS offers to save a password into the person's own keychain when a sheet goes with one typed in it: the fields
  // are emptied on the native side first, and the sheet closes a moment after, whether it was sent or cancelled.
  const close = () => {
    for (const input of inputs.current.values()) input.clear();
    Keyboard.dismiss();
    setValues({});
    setShown(false);
    setSave(true);
    setProblem(undefined);
    setTimeout(props.onClose, CLEAR_MS);
  };
  const send = async () => {
    if (!ready || busy) return;
    haptics.tap();
    setBusy(true);
    setProblem(undefined);
    const why = await props.onSubmit(Object.fromEntries(props.asks.map((f) => [f, values[f] ?? ""])), save);
    setBusy(false);
    if (why !== undefined) {
      haptics.warning();
      return setProblem(why);
    }
    haptics.success();
    close();
  };
  const field = (f: SignInField, i: number) => {
    // iOS offers a strong password, or the person's own saved one, for a username beside a secure field, and to save
    // what was typed: a one-time code's content type on both stops it, so nothing but what they type goes in and
    // nothing is kept outside fleetd's vault.
    const common: TextInputProps & { ref: (r: ComponentRef<typeof TextInput> | null) => void } = {
      ref: (r) => {
        if (r === null) inputs.current.delete(f);
        else inputs.current.set(f, r);
      },
      value: values[f] ?? "",
      onChangeText: (v) => setValues((was) => ({ ...was, [f]: v })),
      placeholder: WORDS[f],
      placeholderTextColor: t.tertiary,
      autoCapitalize: "none",
      autoCorrect: false,
      spellCheck: false,
      autoFocus: i === 0,
      editable: !busy,
      selectionColor: t.accent,
      accessibilityLabel: WORDS[f],
      returnKeyType: i === props.asks.length - 1 ? "go" : "next",
      onSubmitEditing: i === props.asks.length - 1 ? () => void send() : undefined,
      style: [type.body, styles.input, { color: t.label }],
    };
    return (
      <View key={f} style={styles.field}>
        {f === "otp" ? (
          <TextInput {...common} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" />
        ) : f === "password" ? (
          <>
            <TextInput {...common} secureTextEntry={!shown} textContentType="oneTimeCode" autoComplete="off" />
            <Pressable accessibilityRole="button" accessibilityLabel={shown ? "Hide password" : "Show password"} hitSlop={10} onPress={() => setShown((s) => !s)}>
              <Icon name={shown ? "hidden" : "eye"} size={19} color={t.secondary} />
            </Pressable>
          </>
        ) : (
          <TextInput {...common} keyboardType="email-address" textContentType="oneTimeCode" autoComplete="off" />
        )}
      </View>
    );
  };
  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="formSheet" onRequestClose={close} onDismiss={props.onDismissed}>
      <SheetRoom style={{ flex: 1, backgroundColor: t.grouped }}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" onAccessibilityEscape={close}>
          <View style={styles.head}>
            <Text style={[type.title3, { color: t.label }]}>{props.title}</Text>
            <Text style={[type.subhead, { color: t.secondary }]}>
              {props.domain} · {props.why}
            </Text>
          </View>
          <ListSection footer="The agent never sees what you type.">{props.asks.map(field)}</ListSection>
          {props.code ? null : (
            <ListSection>
              <View style={styles.field}>
                <Text style={[type.body, styles.grow, { color: t.label }]}>Securely save to Vault</Text>
                <Switch value={save} onValueChange={setSave} disabled={busy} accessibilityLabel="Securely save to Vault" />
              </View>
            </ListSection>
          )}
          {problem === undefined ? null : (
            <Text style={[type.footnote, styles.problem, { color: t.danger }]} accessibilityRole="alert">
              {problem}
            </Text>
          )}
          <View style={styles.actions}>
            <Button label="Submit" size="large" disabled={!ready || busy} busy={busy} onPress={() => void send()} />
            <Button label="Cancel" kind="plain" size="large" disabled={busy} onPress={close} />
          </View>
        </ScrollView>
      </SheetRoom>
    </Modal>
  );
}

const styles = StyleSheet.create({
  cards: { paddingHorizontal: space.md, paddingTop: space.sm },
  card: { flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: shape.card, borderCurve: "continuous", padding: space.md },
  tile: { width: 40, height: 40, borderRadius: 12, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, gap: 2 },
  strong: { fontWeight: "600", flexShrink: 1 },
  button: { minHeight: 34, borderRadius: 17, paddingHorizontal: 14, justifyContent: "center" },
  pressed: { opacity: PRESSED_OPACITY },
  outcome: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, marginVertical: space.sm, paddingHorizontal: space.xl },
  outcomeText: { flexShrink: 1 },
  body: { paddingTop: space.xl, paddingBottom: space.xxl },
  head: { gap: space.xs, paddingHorizontal: space.xl, marginBottom: space.sm },
  field: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: shape.row, paddingHorizontal: space.lg },
  input: { flex: 1, paddingVertical: 11 },
  problem: { marginHorizontal: space.xl, marginTop: space.sm },
  actions: { gap: space.sm, marginHorizontal: space.lg, marginTop: space.xl },
});
