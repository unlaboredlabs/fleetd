// Under FLEETD_FIXTURE, fleetd cloud's Sign in touches no browser, network or terminal. A fixture's `cloud` section
// (ignored by the hub fixture's schema, as `pair` is) turns Sign in on and says how each step answers, so the QA gate
// shoots the real screens. No section: Sign in is off, as in a release.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { CloudState, ConnectComputerOutcome, SignInOutcome, SignOutOutcome } from "../../shared/cloud";
import type { Cloud } from "./index";

const Failure = z.object({ code: z.string(), message: z.string(), fix: z.string().optional() });

export const CloudSection = z.object({
  /** Signed in as this, from the start. */
  email: z.string().optional(),
  /** The app's first hub came with the account (a team of the person's). */
  hub: z.boolean().optional(),
  /** How Sign in ends: it waits on the browser until Cancel, or fails so. Absent: it waits. */
  signIn: z.union([z.literal("wait"), z.object({ failure: Failure })]).optional(),
  /** The terminal Connect this computer opens; absent: none could be opened. Nothing is ever run. */
  terminal: z.string().optional(),
});
export type CloudSection = z.infer<typeof CloudSection>;

/** The fixture's `cloud` section, or null when it has none. */
export const readCloudSection = (file: string): CloudSection | null =>
  z.object({ cloud: CloudSection.optional() }).parse(JSON.parse(readFileSync(file, "utf8"))).cloud ?? null;

export class FixtureCloud implements Cloud {
  readonly #section: CloudSection | null;
  #email: string | null;
  #waiting: ((outcome: SignInOutcome) => void) | null = null;

  constructor(section: CloudSection | null) {
    this.#section = section;
    this.#email = section?.email ?? null;
  }

  state(): CloudState {
    return { available: this.#section !== null, email: this.#email };
  }

  signIn(): Promise<SignInOutcome> {
    this.cancel();
    const how = this.#section?.signIn ?? "wait";
    if (how !== "wait") {
      const { fix, ...failure } = how.failure;
      return Promise.resolve({ ok: false, failure: fix === undefined ? failure : { ...failure, fix } });
    }
    return new Promise((resolve) => (this.#waiting = resolve));
  }

  cancel(): void {
    this.#waiting?.({ ok: false, cancelled: true });
    this.#waiting = null;
  }

  reopen(): Promise<void> {
    return Promise.resolve();
  }

  link(): string | null {
    return this.#waiting === null ? null : "https://auth.example.com/sign-in";
  }

  signOut(): Promise<SignOutOutcome> {
    this.#email = null;
    return Promise.resolve({ kept: [] });
  }

  connectComputer(): Promise<ConnectComputerOutcome> {
    const terminal = this.#section?.terminal;
    return Promise.resolve(terminal === undefined ? { ok: false, message: "Couldn't open a terminal. Run the line below in one on this computer." } : { ok: true, terminal });
  }
}
