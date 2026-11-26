// fleetd cloud in main: Sign in, Sign out, Connect this computer, a team's invites by email, installing fleetd's
// GitHub App on a team and its billing, behind one interface, which a fixture (fixture.ts) stands in for. Built from config.ts's two build-time values; with neither, `available` is false and
// the page shows the self-hosted app alone.
import { readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { cloudDomain, readAccepted, teamOrigin } from "../../shared/accounts";
import type { BillingCapOutcome, BillingOpen, BillingOpenOutcome, BillingOutcome, CloudState, ConnectComputerOutcome, DeleteTeamOutcome, FinishOutcome, NewWorkspaceOutcome, InstallGithubOutcome, InviteOutcome, InviteRequest, InvitesOutcome, MoveOutcome, MoveTarget, RevokeInviteOutcome, SignInOutcome, SignOutOutcome, AccountPreviewOutcome, DeleteAccountOutcome } from "../../shared/cloud";
import type { HubId } from "../../shared/hubs";
import type { Hubs } from "../hub/hubs";
import type { HubService } from "../hub/service";
import { writePrivate } from "../hub/credentials";
import { realTerminalDeps } from "../pairing/terminal";
import { systemCAs } from "../trust";
import { CloudAccount, SavedAccount, type CloudHub } from "./account";
import type { CloudConfig } from "./config";
import { openBilling, readTeamBilling, setBillingCap } from "./billing";
import { connectComputer } from "./connect";
import { installGithub } from "./github";
import { deleteTeam, listInvites, makeWorkspace, odd, revokeInvite, sendInvite, type KeyedTeam, accountPreview, deleteAccount } from "./invites";

export interface Cloud {
  state(): CloudState;
  signIn(move?: boolean): Promise<SignInOutcome>;
  finish(join: readonly number[], make?: boolean): Promise<FinishOutcome>;
  notMe(): Promise<void>;
  cancel(): void;
  reopen(): Promise<void>;
  link(): string | null;
  signOut(): Promise<SignOutOutcome>;
  connectComputer(hub: HubId): Promise<ConnectComputerOutcome>;
  moveTargets(): MoveTarget[];
  move(from: HubId, to: HubId): Promise<MoveOutcome>;
  invites(hub: HubId): Promise<InvitesOutcome>;
  invite(hub: HubId, request: InviteRequest): Promise<InviteOutcome>;
  revokeInvite(hub: HubId, inviteId: string): Promise<RevokeInviteOutcome>;
  deleteTeam(hub: HubId, name: string): Promise<DeleteTeamOutcome>;
  /** A new empty workspace of the person's own, asked on `from` (one of their cloud workspaces), connected here. */
  newWorkspace(from: HubId, name: string): Promise<NewWorkspaceOutcome>;
  /** What deleting the person's cloud account would take, read before asking. */
  accountPreview(): Promise<AccountPreviewOutcome>;
  /** The person deletes their cloud account for good, `email` theirs typed again; on success the app forgets its workspaces. */
  deleteAccount(email: string): Promise<DeleteAccountOutcome>;
  installGithub(hub: HubId): Promise<InstallGithubOutcome>;
  billing(hub: HubId): Promise<BillingOutcome>;
  billingOpen(hub: HubId, what: BillingOpen): Promise<BillingOpenOutcome>;
  billingCap(hub: HubId, capCents: number | null): Promise<BillingCapOutcome>;
}

/** Asked of a hub that didn't come with the account: the page never offers it there. */
const NOT_CLOUD = { ok: false, failure: { code: "", message: "That workspace isn't one of your fleetd cloud workspaces." } } as const;

/** The account asked about itself with none of its workspaces in the app. */
const NO_WORKSPACE = { ok: false, failure: { code: "", message: "None of your fleetd workspaces is in this app.", fix: "Sign in again, then delete the account." } } as const;

/** Who is signed in, beside the hubs' list; no token is in it. */
export const ACCOUNT_FILE = "desktop-account.json";

const load = (dir: string): SavedAccount | null => {
  try {
    const parsed = SavedAccount.safeParse(JSON.parse(readFileSync(join(dir, ACCOUNT_FILE), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const save = (dir: string, account: SavedAccount | null): void => {
  try {
    if (account === null) rmSync(join(dir, ACCOUNT_FILE), { force: true });
    else writePrivate(dir, ACCOUNT_FILE, JSON.stringify(account));
  } catch (error) {
    console.warn(`Couldn't save ${ACCOUNT_FILE}: ${String(error)}`);
  }
};

const deviceName = (): string => hostname().trim().replace(/\.local$/u, "") || "desktop app";

export const realCloud = (config: CloudConfig | null, hubs: Hubs, dir: string, local: boolean, open: (url: string) => Promise<void>): Cloud => {
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    await systemCAs();
    return globalThis.fetch(url, init);
  };
  /**
   * A hub at a team address, with its key; null for any other. One that came with the account, or one paired with a
   * code (Pair a phone or a device on the team): its key goes only to its own address, which already holds it.
   */
  const team = (id: HubId): KeyedTeam | null => {
    const service = config === null ? undefined : hubs.get(id);
    const keyed = service?.keyed() ?? null;
    const origin = keyed === null || config === null ? null : teamOrigin(keyed.url, config.accountsUrl, local);
    return keyed === null || origin === null ? null : { origin, key: keyed.key, name: hubs.list().find((h) => h.id === id)?.label ?? "Workspace" };
  };
  /** Where the account is asked about itself: any of its workspaces, whose key says who. */
  const accountTeam = (): KeyedTeam | null => hubs.cloudHubs().reduce<KeyedTeam | null>((found, h) => found ?? team(h.id), null);
  const cloudHub = ({ id, label, service }: { id: HubId; label: string; service: HubService }): CloudHub => ({
    id,
    label,
    url: service.url(),
    call: (tool, input) => service.call({ tool, input: input as never }),
    refused: () => service.state().phase === "refused",
  });
  const account = new CloudAccount({
    config,
    local,
    fetch,
    open,
    deviceName,
    connect: (url, key, label, invited) => hubs.connectCloud({ url, key }, label, invited),
    cloudHubs: () => hubs.cloudHubs().map(cloudHub),
    heldAt: (origin) => {
      const held = hubs.heldAt(origin);
      return held === null ? null : cloudHub(held);
    },
    forget: (id) => hubs.remove(id),
    load: () => load(dir),
    save: (a) => save(dir, a),
  });
  return {
    state: () => ({ ...account.state(), domain: config === null ? null : cloudDomain(config.accountsUrl) }),
    signIn: (move) => account.signIn(move === true),
    finish: (join, make) => account.finish(join, make),
    notMe: () => account.notMe(),
    cancel: () => account.cancel(),
    reopen: () => account.reopen(),
    link: () => account.link(),
    signOut: () => account.signOut(),
    moveTargets: () => account.moveTargets().map(({ hub, name }) => ({ hub: hub.id, name })),
    move: async (from, to) => {
      const service = hubs.get(from);
      const t = team(to);
      if (service === undefined) return { ok: false, message: "That workspace was removed from this app." };
      if (t === null) return { ok: false, message: "That workspace isn't connected to this app any more. Sign in again." };
      // The team's key goes to the hub that moves, never through the page.
      const started = await service.call({ tool: "hub_move_start", input: { url: t.origin, key: t.key, team: t.name } });
      return started.ok ? { ok: true } : { ok: false, message: started.error.message };
    },
    connectComputer: async (id) => {
      const service = hubs.get(id);
      if (service === undefined) return { ok: false, message: "That workspace was removed from this app." };
      return connectComputer((tool, input) => service.call({ tool, input }), realTerminalDeps());
    },
    invites: async (id) => {
      const t = team(id);
      return t === null ? NOT_CLOUD : listInvites(fetch, t);
    },
    invite: async (id, request) => {
      const t = team(id);
      return t === null ? NOT_CLOUD : sendInvite(fetch, t, request);
    },
    revokeInvite: async (id, inviteId) => {
      const t = team(id);
      return t === null ? NOT_CLOUD : revokeInvite(fetch, t, inviteId);
    },
    deleteTeam: async (id, name) => {
      const t = team(id);
      if (t === null) return NOT_CLOUD;
      const out = await deleteTeam(fetch, t, name);
      // Gone from the cloud: its key opens nothing now, so the app forgets it as signing out would.
      if (out.ok) hubs.remove(id);
      return out;
    },
    newWorkspace: async (from, name) => {
      const t = team(from);
      if (t === null) return NOT_CLOUD;
      const made = await makeWorkspace(fetch, t, name);
      if (!made.ok) return { ok: false, failure: made.failure };
      const got = readAccepted(made.body);
      return got === null ? odd(t) : account.connectMade(got);
    },
    accountPreview: async () => {
      const t = accountTeam();
      return t === null ? NO_WORKSPACE : accountPreview(fetch, t);
    },
    // Deleted, every key of theirs opens nothing now: the app forgets the account's workspaces without asking them.
    deleteAccount: async (email) => {
      const t = accountTeam();
      if (t === null) return NO_WORKSPACE;
      const out = await deleteAccount(fetch, t, email);
      if (out.ok) account.deleted();
      return out;
    },
    installGithub: async (id) => {
      const t = team(id);
      return t === null ? NOT_CLOUD : installGithub(fetch, t, open);
    },
    billing: async (id) => {
      const t = team(id);
      return t === null ? NOT_CLOUD : readTeamBilling(fetch, t);
    },
    billingOpen: async (id, what) => {
      const t = team(id);
      return t === null ? NOT_CLOUD : openBilling(fetch, t, what, open);
    },
    billingCap: async (id, capCents) => {
      const t = team(id);
      return t === null ? NOT_CLOUD : setBillingCap(fetch, t, capCents);
    },
  };
};
