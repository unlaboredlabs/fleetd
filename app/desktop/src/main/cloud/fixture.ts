// Under FLEETD_FIXTURE, fleetd cloud's Sign in touches no browser, network or terminal. A fixture's `cloud` section
// (ignored by the hub fixture's schema, as `pair` is) turns Sign in on and says how each step answers, so the QA gate
// shoots the real screens. No section: Sign in is off, as in a release. On a fixture whose hub came with the account,
// its invites by email are kept here as the team keeps them: an invite is added, an email already invited refused.
// A sign-in may arrive (`signIn.arrival`): who signed in and the invitations to ask about, as the accounts service
// answers them; Join and Not now then connect nothing, a fixture's hubs being fixed. Its `billing` is the team's
// `GET /billing/v1` answer as the service sends it: Change plan, Add credits and Manage payment open nothing, and a cap,
// a limit or the warnings set are kept here. Its `signin` is the team's `GET /accounts/v1/signin` answer, changes kept too.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { readBilling, type BillingState, type LimitOf } from "../../shared/billing";
import { readSignin, type SigninChange, type SigninState } from "../../shared/signin";
import type { Arrival, BillingCapOutcome, BillingLimitOutcome, BillingWarningsOutcome, SigninDomainOutcome, SigninOutcome, BillingOpenOutcome, BillingOutcome, CloudState, ConnectComputerOutcome, DeleteTeamOutcome, FinishOutcome, NewWorkspaceOutcome, InstallGithubOutcome, InviteOutcome, InviteRequest, InvitesOutcome, MoveOutcome, MoveTarget, RevokeInviteOutcome, SignInOutcome, SignOutOutcome, AccountPreviewOutcome, DeleteAccountOutcome } from "../../shared/cloud";
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
      z.object({
        arrival: z.object({ email: z.string(), invitations: z.array(z.object({ name: z.string(), invitedBy: z.string(), role: z.string() })), canMake: z.literal(true).optional() }),
      }),
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
  /** The team's billing, as `GET /billing/v1` answers it (read through shared/billing.ts's readBilling). */
  billing: z.unknown().optional(),
  /** Reading the billing fails so, as the team would. */
  billingFailure: Failure.optional(),
  /** The team's sign-in, as `GET /accounts/v1/signin` answers it (read through shared/signin.ts's readSignin). */
  signin: z.unknown().optional(),
  /** New workspace is refused so, as the cloud would (the most one person may make). Absent: refused as sample data. */
  newWorkspaceFailure: Failure.optional(),
  /** Delete account is refused so, as the cloud would (the only owner of a workspace with others in it). */
  deleteAccountFailure: Failure.optional(),
  /** What deleting the account would take, as the cloud's preview answers. Absent: the fixture's hub is left, nothing goes. */
  accountPreview: z.object({ deletes: z.array(z.object({ name: z.string(), plan: z.string().nullable() })), leaves: z.array(z.string()), blocked: z.array(z.string()) }).optional(),
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
  #billing: BillingState | null;
  #signin: SigninState | null;

  constructor(section: CloudSection | null) {
    this.#section = section;
    this.#email = section?.email ?? null;
    this.#invites = [...(section?.invites ?? [])];
    this.#billing = section?.billing === undefined ? null : readBilling(section.billing);
    if (section?.billing !== undefined && this.#billing === null) throw new Error("The fixture's cloud.billing isn't a GET /billing/v1 answer.");
    this.#signin = section?.signin === undefined ? null : readSignin(section.signin);
    if (section?.signin !== undefined && this.#signin === null) throw new Error("The fixture's cloud.signin isn't a GET /accounts/v1/signin answer.");
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

  moveTargets(): MoveTarget[] {
    return [];
  }

  move(): Promise<MoveOutcome> {
    return Promise.resolve({ ok: false, message: "Sample data, not connected: nothing moves." });
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
    if (!this.#team()) return Promise.resolve(failed({ code: "", message: "That workspace isn't one of your fleetd cloud workspaces." }));
    return Promise.resolve({ ok: true, invites: [...this.#invites] });
  }

  invite(_hub: string, request: InviteRequest): Promise<InviteOutcome> {
    if (!this.#team()) return Promise.resolve(failed({ code: "", message: "That workspace isn't one of your fleetd cloud workspaces." }));
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

  // A fixture's team stays: the shot shows the sheet's refusal or its press, never the app without it.
  deleteTeam(_hub: string, name: string): Promise<DeleteTeamOutcome> {
    if (!this.#team()) return Promise.resolve(failed({ code: "", message: "That workspace isn't one of your fleetd cloud workspaces." }));
    return Promise.resolve(name.trim() === "" ? failed({ code: "invalid", message: "The workspace's name is missing.", fix: "Type the workspace's name to delete it." }) : { ok: true });
  }

  // A fixture's hubs are fixed: nothing is made, the dialog shows the cloud's refusal.
  newWorkspace(): Promise<NewWorkspaceOutcome> {
    if (!this.#team()) return Promise.resolve(failed({ code: "", message: "That workspace isn't one of your fleetd cloud workspaces." }));
    return Promise.resolve(failed(this.#section?.newWorkspaceFailure ?? { code: "", message: "Sample data, not connected: nothing is made." }));
  }

  accountPreview(): Promise<AccountPreviewOutcome> {
    const preview = this.#section?.accountPreview ?? { deletes: [], leaves: ["acme"], blocked: [] };
    return Promise.resolve({ ok: true, preview: { email: this.#email ?? "", ...preview } });
  }

  // The email typed must be the fixture's; a refusal set for the shot shows instead. Deleted, the account is gone.
  deleteAccount(email: string): Promise<DeleteAccountOutcome> {
    const refusal = this.#section?.deleteAccountFailure;
    if (refusal !== undefined) return Promise.resolve(failed(refusal));
    if (this.#email === null || email.trim().toLowerCase() !== this.#email.toLowerCase()) {
      return Promise.resolve(failed({ code: "wrong_email", message: "That isn't this account's email.", fix: "Type the email you sign in with." }));
    }
    this.#email = null;
    return Promise.resolve({ ok: true, workspaces: [] });
  }

  billing(): Promise<BillingOutcome> {
    if (!this.#team()) return Promise.resolve(failed({ code: "", message: "That workspace isn't one of your fleetd cloud workspaces." }));
    const refusal = this.#section?.billingFailure;
    if (refusal !== undefined) return Promise.resolve(failed(refusal));
    if (this.#billing === null) return Promise.resolve(failed({ code: "not_found", message: "Nothing is here." }));
    return Promise.resolve({ ok: true, billing: this.#billing });
  }

  billingOpen(): Promise<BillingOpenOutcome> {
    if (!this.#team()) return Promise.resolve(failed({ code: "", message: "That workspace isn't one of your fleetd cloud workspaces." }));
    return Promise.resolve({ ok: true });
  }

  billingCap(_hub: string, capCents: number | null): Promise<BillingCapOutcome> {
    if (!this.#team() || this.#billing === null) return Promise.resolve(failed({ code: "", message: "That workspace isn't one of your fleetd cloud workspaces." }));
    const credits = { ...this.#billing.credits, capCents };
    const reached = capCents !== null && credits.capSpentCents >= capCents;
    const held = reached ? "cap" : this.#billing.held === "cap" ? null : this.#billing.held;
    this.#billing = { ...this.#billing, credits, held };
    return Promise.resolve({ ok: true, capCents });
  }

  billingLimit(_hub: string, of: LimitOf, limitCents: number | null): Promise<BillingLimitOutcome> {
    const limits = this.#billing?.limits;
    if (!this.#team() || this.#billing === null || limits === null || limits === undefined) return Promise.resolve(failed({ code: "", message: "That workspace isn't one of your fleetd cloud workspaces." }));
    const set = <T extends { limitCents: number | null; spentCents: number; stopped: boolean }>(row: T): T => ({ ...row, limitCents, stopped: limitCents !== null && row.spentCents >= limitCents });
    const members = limits.members.map((m) => ("personId" in of && m.personId === of.personId ? set(m) : m));
    const bots = limits.bots.map((b) => ("projectId" in of && b.projectId === of.projectId ? set(b) : b));
    const row = "personId" in of ? members.find((m) => m.personId === of.personId) : bots.find((b) => b.projectId === of.projectId);
    if (row === undefined) return Promise.resolve(failed({ code: "not_found", message: "No such person or bot in this workspace." }));
    this.#billing = { ...this.#billing, limits: { members, bots } };
    return Promise.resolve({ ok: true, limit: { limitCents: row.limitCents, spentCents: row.spentCents, stopped: row.stopped } });
  }

  billingWarnings(_hub: string, on: boolean): Promise<BillingWarningsOutcome> {
    const warnings = this.#billing?.warnings;
    if (!this.#team() || this.#billing === null || warnings === null || warnings === undefined) return Promise.resolve(failed({ code: "", message: "That workspace isn't one of your fleetd cloud workspaces." }));
    this.#billing = { ...this.#billing, warnings: { ...warnings, on } };
    return Promise.resolve({ ok: true, on });
  }

  signin(): Promise<SigninOutcome> {
    if (!this.#team() || this.#signin === null) return Promise.resolve(failed({ code: "", message: "That workspace isn't one of your fleetd cloud workspaces." }));
    return Promise.resolve({ ok: true, signin: this.#signin });
  }

  // Refused as the team refuses: domains joining with none verified.
  signinSet(_hub: string, change: SigninChange): Promise<SigninOutcome> {
    const now = this.#signin;
    if (!this.#team() || now === null) return Promise.resolve(failed({ code: "", message: "That workspace isn't one of your fleetd cloud workspaces." }));
    if (change.domainJoin === true && !now.domains.some((d) => d.state === "verified")) return Promise.resolve(failed({ code: "no_domain", message: "Verify an email domain first." }));
    this.#signin = { ...now, ...(change.require === undefined ? {} : { require: change.require }), ...(change.domainJoin === undefined ? {} : { domainJoin: change.domainJoin }) };
    return Promise.resolve({ ok: true, signin: this.#signin });
  }

  signinDomain(): Promise<SigninDomainOutcome> {
    if (!this.#team()) return Promise.resolve(failed({ code: "", message: "That workspace isn't one of your fleetd cloud workspaces." }));
    return Promise.resolve({ ok: true });
  }

  installGithub(): Promise<InstallGithubOutcome> {
    if (!this.#team()) return Promise.resolve(failed({ code: "", message: "That workspace isn't one of your fleetd cloud workspaces." }));
    const refusal = this.#section?.githubInstallFailure;
    if (refusal === undefined) return Promise.resolve({ ok: true });
    const { connectFirst, ...rest } = refusal;
    return Promise.resolve({ ...failed(rest), ...(connectFirst === true ? { connectFirst } : {}) });
  }
}
