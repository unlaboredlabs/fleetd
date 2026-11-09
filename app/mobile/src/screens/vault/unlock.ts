// Face ID, Touch ID or the phone's passcode before a value shows or is copied (vault-design §4.6): a stolen phone that
// was left unlocked still lists the vault, but opens nothing in it. A phone with no passcode set has nothing to ask
// for, and goes on.
import * as LocalAuthentication from "expo-local-authentication";

export type Unlocked = { readonly ok: true } | { readonly ok: false; readonly why?: string };

export const unlock = async (reason: string): Promise<Unlocked> => {
  try {
    if ((await LocalAuthentication.getEnrolledLevelAsync()) === LocalAuthentication.SecurityLevel.NONE) return { ok: true };
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: "Cancel" });
    if (r.success) return { ok: true };
    // Cancelling is the person's own answer: nothing to say.
    if (r.error === "user_cancel" || r.error === "system_cancel" || r.error === "app_cancel") return { ok: false };
    return { ok: false, why: r.error === "lockout" ? "Face ID is locked after too many tries. Unlock the phone with its passcode first." : "Couldn't confirm it's you." };
  } catch {
    return { ok: false, why: "Couldn't confirm it's you." };
  }
};
