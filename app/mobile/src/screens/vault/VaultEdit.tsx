// A vault item added or changed, in a sheet with ✕ and ✓, as iOS's Passwords and Wallet take one: a login's website,
// user name and password; a card's number (its brand named as it's typed, the slash put in its expiry), expiry,
// security code and name, which iOS can fill from a scanned card; an address's lines; a variable's name, value and
// whether it's secret. Changing an item shows its fields empty: what's typed replaces them, what's left empty stays as
// it was, so nothing is revealed just to change one thing, and a field the item can do without has Clear, which takes
// it away. A new login, card or address goes to the team vault; a new variable to the project it was added from. What's
// typed is sealed to the hub as ✓ is tapped (api.ts saveItem), and goes with the sheet.
import { useLayoutEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type TextInputProps } from "react-native";
import { useHub } from "../../hubContext";
import { shape, space, type, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListSection } from "../../ui/List";
import { errorWords, Problem, sheetOptions } from "../manage/parts";
import { saveItem, vaultErrorWords, vaultHub } from "./api";
import { brandOf, check, CLEARABLE, emptyDraft, envNameProblem, groupNumber, isSecretEnv, KIND_WORDS, sitesMeta, titleOf, toggleCleared, typeExpiry, type Draft } from "./model";
import { useVaultNav, useVaultRoute, whoseOf } from "./parts";

export function VaultEdit() {
  const t = useTheme();
  const navigation = useVaultNav();
  const { kind, item, key } = useVaultRoute<"VaultEdit">().params;
  const { state, session } = useHub();
  const { project } = whoseOf(state, key);
  const editing = item !== undefined;
  const [draft, setDraft] = useState<Draft>(() =>
    item === undefined
      ? emptyDraft(kind)
      : { ...emptyDraft(kind), label: item.label, sites: sitesMeta(item).join("\n"), envName: titleOf(item), secret: isSecretEnv(item) },
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // Typing into a field marked to go keeps what's typed instead.
  const set = (k: string) => (v: string) => setDraft((d) => ({ ...d, fields: { ...d.fields, [k]: v }, cleared: d.cleared.filter((c) => c !== k) }));
  const field = (k: string) => draft.fields[k] ?? "";
  const unchanged = editing ? "Unchanged" : undefined;

  const save = async () => {
    if (busy) return;
    const c = check(draft, editing, new Date());
    if (!c.ok) {
      haptics.warning();
      return setProblem(c.problem);
    }
    setBusy(true);
    setProblem(undefined);
    const r = await saveItem(vaultHub(session), {
      ...(item === undefined ? {} : { itemId: item.itemId }),
      kind,
      ...(project === undefined ? {} : { project }),
      label: c.value.label,
      ...(kind === "login" || kind === "address" ? { sites: c.value.sites } : {}),
      // A variable keeps its name: only a new one sends it.
      ...(editing || c.value.envName === undefined || c.value.envName === "" ? {} : { envName: c.value.envName }),
      ...(c.value.secretEnv === undefined ? {} : { secret: c.value.secretEnv }),
      fields: c.value.secret,
    });
    setBusy(false);
    if (!r.ok) {
      haptics.warning();
      return setProblem(`Not saved: ${vaultErrorWords(r.error) ?? errorWords(r.error)}`);
    }
    haptics.success();
    navigation.goBack();
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      title: editing ? `Edit ${KIND_WORDS[kind].one}` : `New ${KIND_WORDS[kind].one}`,
      ...sheetOptions(t, () => navigation.goBack(), { label: "Save", enabled: true, busy, onPress: () => void save() }, !busy),
    });
    // `save` reads the draft.
  }, [navigation, t, busy, draft]);

  // On an edit, a field the item can do without has Clear, which takes it away as ✓ saves (Undo keeps it).
  const row = (k: string, placeholder: string, props: TextInputProps = {}) => {
    const clearable = editing && CLEARABLE[kind].includes(k);
    const gone = draft.cleared.includes(k);
    return (
      <Field
        key={k}
        value={field(k)}
        onChangeText={set(k)}
        placeholder={unchanged === undefined ? placeholder : `${placeholder} · ${gone ? "Removed" : unchanged}`}
        editable={!busy}
        accessibilityLabel={placeholder}
        {...(clearable && (gone || field(k) === "")
          ? {
              action: {
                label: gone ? "Undo" : "Clear",
                hint: gone ? `Keeps its ${placeholder.toLowerCase()}.` : `Takes its ${placeholder.toLowerCase()} away when you save.`,
                onPress: () => {
                  haptics.select();
                  setDraft((d) => toggleCleared(d, k));
                },
              },
            }
          : {})}
        {...props}
      />
    );
  };
  const label = (placeholder: string) => (
    <Field value={draft.label} onChangeText={(label) => setDraft((d) => ({ ...d, label }))} placeholder={placeholder} autoCapitalize="words" editable={!busy} accessibilityLabel="Label" />
  );
  const sites = (placeholder: string) => (
    <Field
      value={draft.sites}
      onChangeText={(sites) => setDraft((d) => ({ ...d, sites }))}
      placeholder={placeholder}
      autoCapitalize="none"
      keyboardType="url"
      textContentType="URL"
      multiline
      editable={!busy}
      accessibilityLabel="Websites"
    />
  );

  const brand = brandOf(field("number"));
  const nameWhy = editing ? undefined : envNameProblem(draft.envName.trim());

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ paddingBottom: space.xxl }} style={{ backgroundColor: t.grouped }}>
      {kind === "login" ? (
        <>
          <ListSection footer="Agents fill it in only on these sites and their subdomains. Paste an address and it's cut to its site.">
            {sites("Website, like amazon.com")}
          </ListSection>
          <ListSection>
            {row("username", "User name", { autoCapitalize: "none", keyboardType: "email-address", textContentType: "username", autoFocus: !editing })}
            {row("password", "Password", { autoCapitalize: "none", secureTextEntry: true, textContentType: "none" })}
          </ListSection>
          <ListSection footer="The setup key or otpauth:// link a site shows for an authenticator app. fleetd makes the codes, and agents fill them in.">
            {row("totp", "Verification code setup key", { autoCapitalize: "none", secureTextEntry: true, textContentType: "none" })}
          </ListSection>
          <ListSection>
            {label("Label")}
            {row("notes", "Notes", { multiline: true })}
          </ListSection>
        </>
      ) : kind === "card" ? (
        <>
          <ListSection footer="Agents fill it in at a checkout they record, and only in the shop's page and its payment provider's. Use a virtual or low-limit card.">
            <Field
              value={field("number")}
              onChangeText={(v) => set("number")(groupNumber(v))}
              placeholder={unchanged === undefined ? "Card number" : `Card number · ${unchanged}`}
              keyboardType="number-pad"
              textContentType="creditCardNumber"
              autoComplete="cc-number"
              autoFocus={!editing}
              editable={!busy}
              accessibilityLabel="Card number"
              trailing={brand}
            />
            <View style={styles.pair}>
              <View style={styles.grow}>
                <Field
                  value={field("expiry")}
                  onChangeText={(v) => set("expiry")(typeExpiry(v, field("expiry")))}
                  placeholder="MM/YY"
                  keyboardType="number-pad"
                  autoComplete="cc-exp"
                  maxLength={5}
                  editable={!busy}
                  accessibilityLabel="Expires"
                />
              </View>
              <View style={[styles.split, { backgroundColor: t.separator }]} />
              <View style={styles.grow}>
                {row("cvc", "Security code", { keyboardType: "number-pad", secureTextEntry: true, textContentType: "creditCardSecurityCode", autoComplete: "cc-csc", maxLength: 4 })}
              </View>
            </View>
            {row("name", "Name on card", { autoCapitalize: "words", textContentType: "creditCardName", autoComplete: "cc-name" })}
          </ListSection>
          <ListSection footer="What you call it here, like Personal Visa.">{label(editing ? "Label" : "Label (optional)")}</ListSection>
        </>
      ) : kind === "address" ? (
        <>
          <ListSection>
            {row("name", "Full name", { autoCapitalize: "words", textContentType: "name", autoComplete: "name", autoFocus: !editing })}
            {row("organization", "Company (optional)", { autoCapitalize: "words", textContentType: "organizationName" })}
          </ListSection>
          <ListSection>
            {row("line1", "Street and number", { autoCapitalize: "words", textContentType: "streetAddressLine1", autoComplete: "address-line1" })}
            {row("line2", "Apartment, suite (optional)", { autoCapitalize: "words", textContentType: "streetAddressLine2", autoComplete: "address-line2" })}
            {row("postalCode", "Postal code", { autoCapitalize: "characters", textContentType: "postalCode", autoComplete: "postal-code" })}
            {row("city", "City", { autoCapitalize: "words", textContentType: "addressCity" })}
            {row("region", "State or region (optional)", { autoCapitalize: "words", textContentType: "addressState" })}
            {row("country", "Country code, like DE", { autoCapitalize: "characters", maxLength: 2, textContentType: "countryName" })}
          </ListSection>
          <ListSection>
            {row("phone", "Phone (optional)", { keyboardType: "phone-pad", textContentType: "telephoneNumber", autoComplete: "tel" })}
            {row("email", "Email (optional)", { autoCapitalize: "none", keyboardType: "email-address", textContentType: "emailAddress", autoComplete: "email" })}
          </ListSection>
          <ListSection footer="Agents fill it in at a checkout they record, on these sites, and on sites the team vault has a login for.">
            {label("Label, like Home")}
            {sites("Websites (optional)")}
          </ListSection>
        </>
      ) : (
        <>
          <ListSection footer={nameWhy ?? (editing ? "A variable keeps its name. Delete it and add another to rename it." : "Agents get it in their environment when they start.")}>
            <Field
              value={draft.envName}
              onChangeText={(envName) => setDraft((d) => ({ ...d, envName }))}
              placeholder="NAME"
              autoCapitalize="characters"
              autoFocus={!editing}
              editable={!busy && !editing}
              accessibilityLabel="Name"
              invalid={nameWhy !== undefined}
            />
            {row("value", "Value", { autoCapitalize: "none", multiline: !draft.secret, secureTextEntry: draft.secret, textContentType: "none" })}
          </ListSection>
          <ListSection footer={draft.secret ? "Hidden in the app and masked in everything agents report. You can see it again after Face ID." : "Shown as it is, like a setting. Use Secret for keys and tokens."}>
            <View style={styles.switchRow}>
              <Text style={[type.body, styles.grow, { color: t.label }]}>Secret</Text>
              <Switch value={draft.secret} onValueChange={(secret) => setDraft((d) => ({ ...d, secret }))} disabled={busy} />
            </View>
          </ListSection>
        </>
      )}

      <Problem text={problem} />
    </ScrollView>
  );
}

/** A field as a grouped row, with an optional quiet word at its end (the card's brand). */
function Field({
  trailing,
  action,
  invalid,
  style,
  ...props
}: TextInputProps & { trailing?: string | undefined; action?: { label: string; hint: string; onPress: () => void }; invalid?: boolean }) {
  const t = useTheme();
  return (
    <View style={styles.field}>
      <TextInput
        placeholderTextColor={t.tertiary}
        autoCorrect={false}
        spellCheck={false}
        selectionColor={t.accent}
        style={[type.body, styles.input, { color: invalid === true ? t.danger : t.label }, style]}
        {...props}
      />
      {trailing === undefined ? null : <Text style={[type.subhead, { color: t.secondary }]}>{trailing}</Text>}
      {action === undefined ? null : (
        <Pressable accessibilityRole="button" accessibilityHint={action.hint} hitSlop={10} onPress={action.onPress}>
          <Text style={[type.subhead, { color: action.label === "Clear" ? t.danger : t.link }]}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: shape.row, paddingHorizontal: space.lg },
  input: { flex: 1, paddingVertical: 11 },
  pair: { flexDirection: "row", alignItems: "stretch" },
  split: { width: StyleSheet.hairlineWidth },
  grow: { flex: 1 },
  switchRow: { flexDirection: "row", alignItems: "center", minHeight: shape.row, paddingHorizontal: space.lg, paddingVertical: 8 },
});
