// fleetd cloud in main: Sign in, Sign out and Connect this computer behind one interface, which a fixture
// (fixture.ts) stands in for. Built from config.ts's two build-time values; with neither, `available` is false and
// the page shows the self-hosted app alone.
import { readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { CloudState, ConnectComputerOutcome, SignInOutcome, SignOutOutcome } from "../../shared/cloud";
import type { HubId } from "../../shared/hubs";
import type { Hubs } from "../hub/hubs";
import { writePrivate } from "../hub/credentials";
import { realTerminalDeps } from "../pairing/terminal";
import { trustSystemCAs } from "../trust";
import { CloudAccount, SavedAccount } from "./account";
import type { CloudConfig } from "./config";
import { connectComputer } from "./connect";

export interface Cloud {
  state(): CloudState;
  signIn(): Promise<SignInOutcome>;
  cancel(): void;
  reopen(): Promise<void>;
  link(): string | null;
  signOut(): Promise<SignOutOutcome>;
  connectComputer(hub: HubId): Promise<ConnectComputerOutcome>;
}

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
  const account = new CloudAccount({
    config,
    local,
    fetch: (url, init) => {
      trustSystemCAs();
      return globalThis.fetch(url, init);
    },
    open,
    deviceName,
    connect: (url, key, label) => hubs.connectCloud({ url, key }, label),
    cloudHubs: () =>
      hubs.cloudHubs().map(({ id, label, service }) => ({
        id,
        label,
        call: (tool, input) => service.call({ tool, input: input as never }),
        refused: () => service.state().phase === "refused",
      })),
    forget: (id) => hubs.remove(id),
    load: () => load(dir),
    save: (a) => save(dir, a),
  });
  return {
    state: () => account.state(),
    signIn: () => account.signIn(),
    cancel: () => account.cancel(),
    reopen: () => account.reopen(),
    link: () => account.link(),
    signOut: () => account.signOut(),
    connectComputer: async (id) => {
      const service = hubs.get(id);
      if (service === undefined) return { ok: false, message: "That hub was removed from this app." };
      return connectComputer((tool, input) => service.call({ tool, input }), realTerminalDeps());
    },
  };
};
