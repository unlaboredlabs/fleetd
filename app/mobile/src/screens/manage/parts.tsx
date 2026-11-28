// What the project screens share: a text field as a grouped row, a row with a checkmark, the hub's error in
// a section's footnote, a sheet's ✕ and ✓ (iOS 26's own bar buttons, prominent for the ✓; text buttons on Android), and
// the destructive confirm (an action sheet on iOS).
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { SymbolView, type AndroidSymbol, type SFSymbol } from "expo-symbols";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { botLocked, type HubError } from "../../desktop";
import { useHub, useSession } from "../../hubContext";
import { shape, space, type, useTheme, type Palette } from "../../theme";
import { haptics } from "../../ui/haptics";
import { UNSPOKEN } from "../../ui/Icon";
import type { Hub } from "./api";
import { addHttps, httpsLine } from "./namedApi";

/** An SF Symbol, with its Material match for Android, for what the app's Icon set doesn't name; unspoken, as an Icon. */
export function Symbol({ ios, android, size = 20, color, weight = "regular" }: { ios: SFSymbol; android: AndroidSymbol; size?: number; color: string; weight?: "regular" | "medium" | "semibold" }) {
  return <SymbolView name={{ ios, android, web: android }} size={size} tintColor={color} weight={weight} {...UNSPOKEN} />;
}

/** A text field as a grouped list's row, as iOS Settings' Name. */
export function FieldRow(props: TextInputProps & { invalid?: boolean }) {
  const t = useTheme();
  const { invalid, style, ...rest } = props;
  return (
    <View style={styles.field}>
      <TextInput
        placeholderTextColor={t.tertiary}
        clearButtonMode="while-editing"
        autoCorrect={false}
        style={[type.body, styles.input, { color: invalid === true ? t.danger : t.label }, style]}
        selectionColor={t.accent}
        {...rest}
      />
    </View>
  );
}

/** A row that is picked or not: a checkmark on the right, as iOS's own selection lists. */
export function CheckRow({ title, detail, checked, disabled = false, onPress }: { title: string; detail?: string | undefined; checked: boolean; disabled?: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: checked, disabled }} disabled={disabled} onPress={onPress}>
      {({ pressed }) => (
        <View style={[styles.check, pressed && { backgroundColor: t.fillQuiet }]}>
          <View style={styles.grow}>
            <Text style={[type.body, { color: disabled && !checked ? t.tertiary : t.label }]} numberOfLines={1}>
              {title}
            </Text>
            {detail === undefined || detail === "" ? null : <Text style={[type.footnote, { color: t.secondary }]}>{detail}</Text>}
          </View>
          <View style={styles.mark}>{checked ? <Symbol ios="checkmark" android="check" size={17} color={disabled ? t.tertiary : t.accent} weight="semibold" /> : null}</View>
        </View>
      )}
    </Pressable>
  );
}

/** The hub's words for what went wrong, and its fix. */
export const errorWords = (e: Pick<HubError, "message" | "fix">): string => (e.fix === undefined || e.fix.trim() === "" ? e.message : `${e.message} ${e.fix}`).replace(/`/gu, "");

/** A footnote in red under a section, or nothing. */
export function Problem({ text }: { text: string | undefined }) {
  const t = useTheme();
  if (text === undefined) return null;
  return (
    <Text style={[type.footnote, styles.problem, { color: t.danger }]} accessibilityRole="alert">
      {text}
    </Text>
  );
}

/**
 * True for a member, and until the workspace has said who this phone's person is: a bot's safety settings (who merges, approvals,
 * payments, watchers, deleting it) are its admins', so a member sees them off, with BOT_ADMIN_ONLY under them.
 */
export function useBotLocked(): boolean {
  const { state } = useHub();
  // `admin` is set once the workspace has answered who this phone's person is; before that, locked.
  return botLocked(state.meRole ?? (state.admin === undefined ? undefined : null));
}

/** A section's own footnote under something that isn't a ListSection. */
export function Note({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <Text style={[type.footnote, styles.problem, { color: t.secondary }]}>{children}</Text>;
}

export interface SheetDone {
  readonly label: string;
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly onPress: () => void;
}

function TextButton({ label, onPress, disabled = false, bold = false }: { label: string; onPress: () => void; disabled?: boolean; bold?: boolean }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} hitSlop={12}>
      <Text style={[type.body, { color: disabled ? t.tertiary : t.accent, fontWeight: bold ? "600" : "400" }]}>{label}</Text>
    </Pressable>
  );
}

/** Runs a bar button's handler once UIKit is done with the tap: one that re-renders the bar from inside it crashes. */
const afterTap = (run: () => void) => () => void setTimeout(run, 0);

/** A sheet's bar: ✕ to close it, and a prominent ✓ that does its one thing, greyed while it does. */
export const sheetOptions = (t: Palette, onCancel: (() => void) | undefined, done: SheetDone | undefined, cancelable = true): NativeStackNavigationOptions => {
  if (Platform.OS === "ios") {
    return {
      unstable_headerLeftItems: () => (onCancel === undefined ? [] : [{ type: "button", label: "Cancel", icon: { type: "sfSymbol", name: "xmark" }, disabled: !cancelable, onPress: afterTap(onCancel) }]),
      unstable_headerRightItems: () =>
        done === undefined
          ? []
          : [{ type: "button", label: done.label, icon: { type: "sfSymbol", name: "checkmark" }, variant: "prominent", tintColor: t.accentFill, disabled: !done.enabled || done.busy, onPress: afterTap(done.onPress) }],
    };
  }
  return {
    headerLeft: () => (onCancel === undefined ? null : <TextButton label="Cancel" onPress={onCancel} disabled={!cancelable} />),
    headerRight: () => (done === undefined ? null : done.busy ? <ActivityIndicator color={t.secondary} /> : <TextButton label={done.label} onPress={done.onPress} disabled={!done.enabled} bold />),
  };
};

/** Asks before something that can't be taken back: a red action in an action sheet on iOS, an alert on Android. */
export const confirmDestructive = (o: { title: string; message: string; button: string; onConfirm: () => void }): void => {
  haptics.warning();
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions({ title: o.title, message: o.message, options: [o.button, "Cancel"], destructiveButtonIndex: 0, cancelButtonIndex: 1 }, (i) => {
      if (i === 0) o.onConfirm();
    });
    return;
  }
  Alert.alert(o.title, o.message, [
    { text: "Cancel", style: "cancel" },
    { text: o.button, style: "destructive", onPress: o.onConfirm },
  ]);
};

/**
 * A read that runs on mount, again on `reload`, and again each time the link is live again (one that failed while it
 * was down never keeps saying so), keeping what it had while it reads again.
 */
export const useRead = <T,>(read: () => Promise<T>, deps: readonly unknown[]): { value: T | undefined; reading: boolean; reload: () => void } => {
  const session = useSession();
  const [value, setValue] = useState<T | undefined>(undefined);
  const [reading, setReading] = useState(true);
  const gen = useRef(0);
  // `read` is new on each render; what it reads is in `deps`.
  const run = useCallback(read, deps);
  const reload = useCallback(() => {
    const mine = ++gen.current;
    setReading(true);
    void run().then((v) => {
      if (mine !== gen.current) return;
      setValue(v);
      setReading(false);
    });
  }, [run]);
  useEffect(() => {
    reload();
    return () => {
      gen.current++;
    };
  }, [reload]);
  useEffect(() => session.onLive(reload), [session, reload]);
  return { value, reading, reload };
};

const styles = StyleSheet.create({
  field: { minHeight: shape.row, justifyContent: "center", paddingHorizontal: space.lg },
  input: { paddingVertical: 11 },
  check: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: shape.row, paddingHorizontal: space.lg, paddingVertical: 11 },
  grow: { flex: 1 },
  mark: { width: 22, alignItems: "flex-end" },
  problem: { marginHorizontal: space.lg * 2, paddingTop: 7 },
});

/**
 * After a sign-in refused for want of https: an admin is offered the address in one tap, then the sign-in again;
 * anyone else is told an admin can. `said` gets the fix by hand when the workspace can't give itself one.
 */
export function offerHttps(hub: Hub, label: string, admin: boolean, again: () => void, said: (text: string) => void): void {
  if (!admin) {
    Alert.alert(httpsLine(label), "An admin can give the workspace an https address in Connections.");
    return;
  }
  Alert.alert(httpsLine(label), "fleetd can give the workspace one with Tailscale, then sign in again.", [
    { text: "Not Now", style: "cancel" },
    {
      text: "Give It One",
      onPress: () =>
        void addHttps(hub).then((out) => {
          if (out.ok) again();
          else said(errorWords(out.error));
        }),
    },
  ]);
}
