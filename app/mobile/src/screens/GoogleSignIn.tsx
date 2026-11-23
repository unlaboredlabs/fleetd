// Google's sign-in on one machine, as the desktop's (settings/GoogleSignIn.tsx): Sign In with Google asks the machine
// (machine_antigravity_login), which says the plan it is signed in on, or starts Antigravity's own sign-in (installing
// it first where there is none) and answers the Google page, which opens; the person pastes the code it shows, and only
// that code passes through the hub, once. Used on Providers › Google, for each machine, and on Lead Model while its
// lead runs on Google and Google isn't connected.
import { useState } from "react";
import { Linking, StyleSheet, TextInput, View } from "react-native";
import { useHub } from "../hubContext";
import { shape, space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { errorWords, Problem } from "./manage/parts";

/** A first sign-in may install Antigravity on the machine first: the hub waits as long. */
export const AGY_SIGN_IN_WAIT_MS = 600_000;
/** Finishing with the code: the hub waits 90 s for the machine (fleetd's computers type it into a computer of
 * their own first), as the desktop's MACHINE_WAIT_MS does. */
const CODE_WAIT_MS = 100_000;
/** The row while a sign-in starts, until Google's page opens: its title and the line under it. */
export const STARTING = ["Starting a Sign-In…", "Google's sign-in page opens once it's ready."] as const;

type Step = { step: "idle" } | { step: "starting" } | { step: "url"; url: string } | { step: "finishing"; url: string } | { step: "signed"; plan: string };

/** One machine's sign-in, under its name: Signed In with the plan once it is (`signedIn`, as antigravity_status says). */
export function GoogleSignIn({ machineId, name, signedIn, onSigned }: { machineId: string; name: string; signedIn?: string | undefined; onSigned?: () => void }) {
  const t = useTheme();
  const { session } = useHub();
  const [now, setStep] = useState<Step>({ step: "idle" });
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const step: Step = now.step === "idle" && signedIn !== undefined && problem === undefined ? { step: "signed", plan: signedIn } : now;

  const start = async () => {
    haptics.select();
    setProblem(undefined);
    setCode("");
    setStep({ step: "starting" });
    const out = await session.call("machine_antigravity_login", { machineId }, AGY_SIGN_IN_WAIT_MS);
    if (!out.ok) {
      setStep({ step: "idle" });
      return setProblem(`Not signed in: ${errorWords(out.error)}`);
    }
    if (out.output.signedIn !== undefined) {
      setStep({ step: "signed", plan: out.output.signedIn });
      return onSigned?.();
    }
    if (out.output.loginUrl === undefined) return setStep({ step: "idle" });
    setStep({ step: "url", url: out.output.loginUrl });
    void Linking.openURL(out.output.loginUrl);
  };
  const finish = async (url: string) => {
    if (code.trim() === "") return;
    setProblem(undefined);
    setStep({ step: "finishing", url });
    const out = await session.call("machine_antigravity_login", { machineId, code: code.trim() }, CODE_WAIT_MS);
    if (!out.ok) {
      haptics.warning();
      // A used or wrong code is spent: the sign-in has ended, so it starts again.
      setStep({ step: "idle" });
      return setProblem(`Not signed in: ${errorWords(out.error)}`);
    }
    haptics.success();
    setCode("");
    setStep({ step: "signed", plan: out.output.signedIn ?? "Google" });
    onSigned?.();
  };

  return (
    <>
      <ListSection header={name}>
        {step.step === "signed" ? (
          <ListRow title="Google" value={`Signed In · ${step.plan}`} />
        ) : step.step === "url" || step.step === "finishing" ? (
          <>
            <ListRow title="Open Google Sign-In" onPress={() => void Linking.openURL(step.url)} />
            <View style={styles.field}>
              <TextInput
                value={code}
                onChangeText={setCode}
                placeholder="The code the page shows"
                placeholderTextColor={t.tertiary}
                textContentType="oneTimeCode"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                editable={step.step === "url"}
                accessibilityLabel="The code the page shows"
                selectionColor={t.accent}
                style={[type.body, styles.input, { color: t.label }]}
              />
            </View>
            <ListRow
              title={step.step === "finishing" ? "Signing In…" : "Sign In"}
              {...(step.step === "url" && code.trim() !== "" ? { onPress: () => void finish(step.url) } : {})}
              chevron={false}
            />
          </>
        ) : (
          step.step === "starting" ? (
            // Words while it starts, never a dead row: the machine may start a computer or install Antigravity first.
            <ListRow title={STARTING[0]} detail={STARTING[1]} chevron={false} />
          ) : (
            <ListRow title="Sign In with Google" tint={t.accent} onPress={() => void start()} chevron={false} />
          )
        )}
      </ListSection>
      <Problem text={problem} />
    </>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: "row", alignItems: "center", minHeight: shape.row, paddingHorizontal: space.lg },
  input: { flex: 1, paddingVertical: 11 },
});
