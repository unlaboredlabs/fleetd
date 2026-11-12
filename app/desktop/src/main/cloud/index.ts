// fleetd cloud in main: Sign in, Sign out, Connect this computer and a team's invites by email behind one interface, which a fixture
// (fixture.ts) stands in for. Built from config.ts's two build-time values; with neither, `available` is false and
// the page shows the self-hosted app alone.
import { readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { cloudDomain, teamOrigin } from "../../shared/accounts";
import type { CloudState, ConnectComputerOutcome, FinishOutcome, InviteOutcome, InviteRequest, InvitesOutcome, RevokeInviteOutcome, SignInOutcome, SignOutOutcome } from "../../shared/cloud";
import type { HubId } from "../../shared/hubs";
import type { Hubs } from "../hub/hubs";
import type { HubService } from "../hub/service";
import { writePrivate } from "../hub/credentials";
import { realTerminalDeps } from "../pairing/terminal";
import { trustSystemCAs } from "../trust";
import { CloudAccount, SavedAccount, type CloudHub } from "./account";
import type { CloudConfig } from "./config";
import { connectComputer } from "./connect";
import { listInvites, revokeInvite, sendInvite, type KeyedTeam } from "./invites";

export interface Cloud {
  state(): CloudState;
  signIn(): Promise<SignInOutcome>;
  finish(join: readonly number[]): Promise<FinishOutcome>;
  notMe(): Promise<void>;
  cancel(): void;
  reopen(): Promise<void>;
  link(): string | null;
  signOut(): Promise<SignOutOutcome>;
  connectComputer(hub: HubId): Promise<ConnectComputerOutcome>;
  invites(hub: HubId): Promise<InvitesOutcome>;
  invite(hub: HubId, request: InviteRequest): Promise<InviteOutcome>;
  revokeInvite(hub: HubId, inviteId: string): Promise<RevokeInviteOutcome>;
}

/** Asked of a hub that didn't come with the account: the page never offers it there. */
const NOT_CLOUD = { ok: false, failure: { code: "", message: "That hub isn't one of your fleetd cloud teams." } } as const;

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
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    trustSystemCAs();
    return globalThis.fetch(url, init);
  };
  /** A hub that came with the account, at a team address, with its key; null for any other. */
  const team = (id: HubId): KeyedTeam | null => {
    const hub = config === null ? undefined : hubs.cloudHubs().find((h) => h.id === id);
    const keyed = hub?.service.keyed() ?? null;
    const origin = keyed === null || config === null ? null : teamOrigin(keyed.url, config.accountsUrl, local);
    return hub === undefined || keyed === null || origin === null ? null : { origin, key: keyed.key, name: hub.label };
  };
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
    signIn: () => account.signIn(),
    finish: (join) => account.finish(join),
    notMe: () => account.notMe(),
    cancel: () => account.cancel(),
    reopen: () => account.reopen(),
    link: () => account.link(),
    signOut: () => account.signOut(),
    connectComputer: async (id) => {
      const service = hubs.get(id);
      if (service === undefined) return { ok: false, message: "That hub was removed from this app." };
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
  };
};
