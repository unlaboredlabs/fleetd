// Under FLEETD_FIXTURE, fleetd cloud's Sign in touches no browser, network or terminal. A fixture's `cloud` section
// (ignored by the hub fixture's schema, as `pair` is) turns Sign in on and says how each step answers, so the QA gate
// shoots the real screens. No section: Sign in is off, as in a release. On a fixture whose hub came with the account,
// its invites by email are kept here as the team keeps them: an invite is added, an email already invited refused.
// A sign-in may arrive (`signIn.arrival`): who signed in and the invitations to ask about, as the accounts service
// answers them; Join and Not now then connect nothing, a fixture's hubs being fixed.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Arrival, CloudState, ConnectComputerOutcome, FinishOutcome, InstallGithubOutcome, InviteOutcome, InviteRequest, InvitesOutcome, RevokeInviteOutcome, SignInOutcome, SignOutOutcome } from "../../shared/cloud";
import type { AccountsInvite } from "../../shared/contracts";
import type { Cloud } from "./index";

const Failure = z.object({ code: z.string(), message: z.string(), fix: z.string().optional() });
type Failure = z.infer<typeof Failure>;

const Invite = z.object({ inviteId: z.string(), email: z.string(), role: z.string(), createdAt: z.string(), expiresAt: z.string() });

const failed = ({ fix, ...rest }: Failure) => ({ ok: false, failure: fix === undefined ? rest : { ...rest, fix } }) as const;

export const CloudSection = z.object({
  /** Signed in as this, from the start. */
  email: z.string().optional(),
  /** The app's first hub came with the account (a team of the person's). */
  hub: z.boolean().optional(),
  /** How Sign in ends: it waits on the browser until Cancel, fails so, or arrives with this answer. Absent: it waits. */
  signIn: z
    .union([
      z.literal("wait"),
      z.object({ failure: Failure }),
      z.object({ arrival: z.object({ email: z.string(), invitations: z.array(z.object({ name: z.string(), invitedBy: z.string(), role: z.string() })) }) }),
    ])
    .optional(),
  /** The terminal Connect this computer opens; absent: none could be opened. Nothing is ever run. */
  terminal: z.string().optional(),
  /** The team's open invites by email, newest first. */
  invites: z.array(Invite).optional(),
  /** Every invite by email is refused so, as the team would (its limit of people, say). */
  inviteFailure: Failure.optional(),
  /** Installing fleetd's GitHub App is refused so; with `connectFirst`, as the team answers a person whose own GitHub isn't connected. Absent: GitHub's page "opens". */
  githubInstallFailure: Failure.extend({ connectFirst: z.literal(true).optional() }).optional(),
});
export type CloudSection = z.infer<typeof CloudSection>;

/** The fixture's `cloud` section, or null when it has none. */
export const readCloudSection = (file: string): CloudSection | null =>
  z.object({ cloud: CloudSection.optional() }).parse(JSON.parse(readFileSync(file, "utf8"))).cloud ?? null;

export class FixtureCloud implements Cloud {
  readonly #section: CloudSection | null;
  #email: string | null;
  #waiting: ((outcome: SignInOutcome) => void) | null = null;
  #invites: AccountsInvite[];
  #next = 0;
  #arrival: Arrival | null = null;

  constructor(section: CloudSection | null) {
    this.#section = section;
    this.#email = section?.email ?? null;
    this.#invites = [...(section?.invites ?? [])];
  }

  state(): CloudState {
    return { available: this.#section !== null, email: this.#email, domain: this.#section === null ? null : "fleetd.dev" };
  }

  signIn(): Promise<SignInOutcome> {
    this.cancel();
    const how = this.#section?.signIn ?? "wait";
    if (how !== "wait" && "arrival" in how) {
      this.#arrival = how.arrival;
      return Promise.resolve({ ok: true, arrival: how.arrival });
    }
    if (how !== "wait") {
      const { fix, ...failure } = how.failure;
      return Promise.resolve({ ok: false, failure: fix === undefined ? failure : { ...failure, fix } });
    }
    return new Promise((resolve) => (this.#waiting = resolve));
  }

  finish(join: readonly number[]): Promise<FinishOutcome> {
    const arrival = this.#arrival;
    this.#arrival = null;
    if (arrival === null) return Promise.resolve(failed({ code: "", message: "That sign-in isn't waiting any more.", fix: "Sign in again." }));
    this.#email = arrival.email;
    return Promise.resolve({ ok: true, email: arrival.email, teams: join.flatMap((at) => (arrival.invitations[at] === undefined ? [] : [{ name: arrival.invitations[at].name, ok: true as const }])) });
  }

  notMe(): Promise<void> {
    this.#arrival = null;
    return Promise.resolve();
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

  /** Only the fixture's hub, and only when it came with the account. */
  #team(): boolean {
    return this.#section?.hub === true;
  }

  invites(): Promise<InvitesOutcome> {
    if (!this.#team()) return Promise.resolve(failed({ code: "", message: "That hub isn't one of your fleetd cloud teams." }));
    return Promise.resolve({ ok: true, invites: [...this.#invites] });
  }

  invite(_hub: string, request: InviteRequest): Promise<InviteOutcome> {
    if (!this.#team()) return Promise.resolve(failed({ code: "", message: "That hub isn't one of your fleetd cloud teams." }));
    const refusal = this.#section?.inviteFailure;
    if (refusal !== undefined) return Promise.resolve(failed(refusal));
    const email = request.email.trim().toLowerCase();
    if (this.#invites.some((i) => i.email === email)) {
      return Promise.resolve(failed({ code: "already_invited", message: `${email} is invited already.`, fix: "Revoke that invite first to send a new one." }));
    }
    // The fixtures' own clock (fixtures/kit's NOW), so a shot never shows today's date.
    const at = Date.parse("2026-10-19T10:30:00.000Z");
    const invite = {
      inviteId: `inv_${String(this.#next++).padStart(10, "f")}`,
      email,
      role: request.role,
      createdAt: new Date(at).toISOString(),
      expiresAt: new Date(at + 7 * 24 * 60 * 60_000).toISOString(),
    };
    this.#invites = [invite, ...this.#invites];
    return Promise.resolve({ ok: true, invite });
  }

  revokeInvite(_hub: string, inviteId: string): Promise<RevokeInviteOutcome> {
    this.#invites = this.#invites.filter((i) => i.inviteId !== inviteId);
    return Promise.resolve({ ok: true });
  }

  installGithub(): Promise<InstallGithubOutcome> {
    if (!this.#team()) return Promise.resolve(failed({ code: "", message: "That hub isn't one of your fleetd cloud teams." }));
    const refusal = this.#section?.githubInstallFailure;
    if (refusal === undefined) return Promise.resolve({ ok: true });
    const { connectFirst, ...rest } = refusal;
    return Promise.resolve({ ...failed(rest), ...(connectFirst === true ? { connectFirst } : {}) });
  }
}
