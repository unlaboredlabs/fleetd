// A sign-in form's words and fields (SignIn.tsx), with no React Native in them.
import type { SignInField } from "../desktop";

/** A form that asks only for a one-time code: the step after a password. */
export const codeOnly = (fields: readonly SignInField[]): boolean => fields.length === 1 && fields[0] === "otp";

/** What the form asks for: a whole login (so the vault keeps it whole), and the code when the page shows one. */
export const signInAsks = (fields: readonly SignInField[]): SignInField[] =>
  codeOnly(fields) ? ["otp"] : fields.includes("otp") ? ["username", "password", "otp"] : ["username", "password"];

/** The line a filled form folds to. */
export const signInOutcome = (fields: readonly SignInField[], saved: boolean): string => (codeOnly(fields) ? "Code filled in" : saved ? "Filled in, saved to Vault" : "Filled in");
