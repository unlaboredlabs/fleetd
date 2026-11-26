// A sign-in form in a chat (request_sign_in): a card naming the site, and the native sheet it opens with the email or
// username, the password with a show toggle (or the code the site sent), "Securely save to Vault" on by default, and
// Submit. What is typed is sealed on the phone to the workspace's own key and goes with secret_submit; the workspace
// fills it into the agent's page and, saved, keeps the login in the team vault for that site. It never enters the chat.
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type TextInputProps } from "react-native";
import type { SecretRequestItem, SignInField } from "../desktop";
import { useHub } from "../hubContext";
import { shape, space, type, useTheme } from "../theme";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { ListSection } from "../ui/List";
import { SheetRoom } from "../ui/StripRoom";
import { errorWords } from "./manage/parts";
import { codeOnly, signInAsks, signInOutcome } from "./signInModel";
import { sealToHub } from "./vault/api";

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
    setDone(signInOutcome(signIn.fields, typeof next === "string" && next.includes("saved to the vault as")));
    return undefined;
  };
  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <View style={[styles.mark, { backgroundColor: t.fillQuiet }]}>
          <Icon name="credential" size={17} color={t.secondary} />
        </View>
        <View style={styles.grow}>
          <Text style={[type.headline, { color: t.label }]} numberOfLines={2}>
            {input.label}
          </Text>
          <Text style={[type.footnote, { color: t.secondary }]} numberOfLines={1}>
            {input.site.domain} · {code ? "Asks for the code it sent you" : "Opens a secure form"}
          </Text>
        </View>
        <Button
          label="Open"
          kind="tinted"
          size="small"
          disabled={sealTo === undefined}
          onPress={() => {
            haptics.tap();
            setOpen(true);
          }}
        />
      </View>
      {sealTo === undefined ? <Text style={[type.footnote, { color: t.warning }]}>Update fleetd on the workspace's machine to fill this in here.</Text> : null}
      <SignInSheet visible={open} title={input.label} domain={input.site.domain} why={input.why} asks={signInAsks(signIn.fields)} code={code} onClose={() => setOpen(false)} onSubmit={submit} />
    </Card>
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
  onSubmit: (values: Partial<Record<SignInField, string>>, save: boolean) => Promise<string | undefined>;
}) {
  const t = useTheme();
  const [values, setValues] = useState<Partial<Record<SignInField, string>>>({});
  const [shown, setShown] = useState(false);
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const ready = props.asks.every((f) => (values[f] ?? "").trim() !== "");
  const reset = () => {
    setValues({});
    setShown(false);
    setSave(true);
    setProblem(undefined);
  };
  const close = () => {
    reset();
    props.onClose();
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
    // iOS offers a strong password or the person's own saved one for a username beside a secure field; a one-time
    // code's content type stops that, so nothing but what they type goes in (as the vault's own form does).
    const common: TextInputProps = {
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
          <TextInput {...common} keyboardType="email-address" textContentType="none" autoComplete="off" />
        )}
      </View>
    );
  };
  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="formSheet" onRequestClose={close}>
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
  card: { gap: space.sm },
  row: { flexDirection: "row", alignItems: "center", gap: space.md },
  mark: { width: 36, height: 36, borderRadius: 10, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, gap: 1 },
  outcome: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, marginVertical: space.sm, paddingHorizontal: space.xl },
  outcomeText: { flexShrink: 1 },
  body: { paddingTop: space.xl, paddingBottom: space.xxl },
  head: { gap: space.xs, paddingHorizontal: space.xl, marginBottom: space.sm },
  field: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: shape.row, paddingHorizontal: space.lg },
  input: { flex: 1, paddingVertical: 11 },
  problem: { marginHorizontal: space.xl, marginTop: space.sm },
  actions: { gap: space.sm, marginHorizontal: space.lg, marginTop: space.xl },
});
