// Which Claude account each agent runs on (crates/fleetd/src/hub/claude_accounts/mod.rs, teams step 8, D200). The
// hub keeps the hub's API configuration, each person's subscription and choice, and the hub-wide switch, with each
// node's fingerprint and never a key or token (`claude_accounts`, `claude_choices`, `claude_settings`).
//
// At each launch the hub works out whose work it is (`whoseForTask`, `whoseForLead`) and what that runs on
// (`Setup.runsOn`), sends the account in the launch and records it per thread (`thread_accounts`).
import type {
  ClaudeAccount,
  ClaudeChoice,
  ClaudeHubApi,
  ClaudeRunsOn,
  ClaudeSettings,
  ClaudeSubscription,
  HubRole,
  Person,
  PersonClaude,
  ProjectRef,
} from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import { activePeople, administers, refOf } from "./people.ts";

const HUB = "hub";
const MEMBERS_USE_HUB_API = "members_use_hub_api";
export const CONNECT_REFUSAL = "Connect your Claude to start this order.";

/** Whose work a launch is: the hub's (a lead, or work nobody started), or a person's (their order, their Navi). */
export type Whose = { hub: true } | { person: string };

/** `hub`, or the person's id: how the hub and the node key an account's records and usage. */
export const accountKey = (a: ClaudeAccount) => (a.kind === "hub" ? "hub" : a.personId);
export function accountFromKey(key: string): ClaudeAccount | undefined {
  if (key === "hub") return { kind: "hub" };
  return /^p_[a-z2-7]{8}$/.test(key) ? { kind: "person", personId: key } : undefined;
}

const parse = <T>(data: string | undefined | null): T | undefined => {
  if (data == null) return undefined;
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
};

export class ClaudeAccountStore {
  constructor(private readonly db: HubDb) {}

  private get<T>(account: string): T | undefined {
    const row = this.db.conn.query<{ data: string }, [string]>("SELECT data FROM claude_accounts WHERE account = ?").get(account);
    return parse<T>(row?.data);
  }

  private put(account: string, value: unknown): void {
    this.db.conn
      .query("INSERT INTO claude_accounts (account, data) VALUES (?, ?) ON CONFLICT (account) DO UPDATE SET data = excluded.data")
      .run(account, JSON.stringify(value));
  }

  private remove(account: string): boolean {
    return this.db.conn.query("DELETE FROM claude_accounts WHERE account = ?").run(account).changes > 0;
  }

  hubApi = () => this.get<ClaudeHubApi>(HUB);
  putHubApi = (api: ClaudeHubApi) => this.put(HUB, api);
  removeHubApi = () => this.remove(HUB);
  subscription = (person: string) => this.get<ClaudeSubscription>(person);
  putSubscription = (person: string, s: ClaudeSubscription) => this.put(person, s);
  removeSubscription = (person: string) => this.remove(person);

  /** Every connected subscription, by person. */
  subscriptions(): Map<string, ClaudeSubscription> {
    const rows = this.db.conn
      .query<{ account: string; data: string }, [string]>("SELECT account, data FROM claude_accounts WHERE account != ?")
      .all(HUB);
    const out = new Map<string, ClaudeSubscription>();
    for (const r of rows.sort((a, b) => (a.account < b.account ? -1 : 1))) {
      const s = parse<ClaudeSubscription>(r.data);
      if (s) out.set(r.account, s);
    }
    return out;
  }

  choice(person: string): ClaudeChoice | undefined {
    const row = this.db.conn.query<{ choice: string }, [string]>("SELECT choice FROM claude_choices WHERE person_id = ?").get(person);
    return row?.choice === "subscription" || row?.choice === "hub_api" ? row.choice : undefined;
  }

  setChoice(person: string, choice: ClaudeChoice | undefined): void {
    if (choice === undefined) this.db.conn.query("DELETE FROM claude_choices WHERE person_id = ?").run(person);
    else {
      this.db.conn
        .query("INSERT INTO claude_choices (person_id, choice) VALUES (?, ?) ON CONFLICT (person_id) DO UPDATE SET choice = excluded.choice")
        .run(person, choice);
    }
  }

  private choices(): Map<string, ClaudeChoice> {
    const out = new Map<string, ClaudeChoice>();
    for (const r of this.db.conn.query<{ person_id: string; choice: string }, []>("SELECT person_id, choice FROM claude_choices").all()) {
      if (r.choice === "subscription" || r.choice === "hub_api") out.set(r.person_id, r.choice);
    }
    return out;
  }

  /** The hub-wide switches; no row is the default. */
  settings(): ClaudeSettings {
    const row = this.db.conn.query<{ value: number }, [string]>("SELECT value FROM claude_settings WHERE key = ?").get(MEMBERS_USE_HUB_API);
    return { membersUseHubApi: row === null || row.value !== 0 };
  }

  setSettings(settings: ClaudeSettings): void {
    this.db.conn
      .query("INSERT INTO claude_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(MEMBERS_USE_HUB_API, settings.membersUseHubApi ? 1 : 0);
  }

  /** The account a session was launched on; none for the machine's own login. */
  threadAccount(machineId: string, threadId: string): ClaudeAccount | undefined {
    const row = this.db.conn
      .query<{ account: string }, [string, string]>("SELECT account FROM thread_accounts WHERE machine_id = ? AND thread_id = ?")
      .get(machineId, threadId);
    return row ? accountFromKey(row.account) : undefined;
  }

  setThreadAccount(machineId: string, threadId: string, account: ClaudeAccount): void {
    this.db.conn
      .query(
        `INSERT INTO thread_accounts (machine_id, thread_id, account) VALUES (?, ?, ?)
         ON CONFLICT (machine_id, thread_id) DO UPDATE SET account = excluded.account`,
      )
      .run(machineId, threadId, accountKey(account));
  }

  /** Everything `Setup.runsOn` reads, as it is now. */
  setup(): Setup {
    const people = activePeople(this.db.conn);
    return new Setup(
      this.hubApi(),
      this.settings(),
      this.subscriptions(),
      this.choices(),
      people.find((p) => p.role === "owner")?.personId,
      new Map(people.map((p) => [p.personId, p.role])),
    );
  }
}

/** One way some work could run, and whether it is there. */
type Way = { account: ClaudeAccount; held?: string[]; barred?: string };

const accountText = (a: ClaudeAccount) => (a.kind === "hub" ? "The hub's API key" : "The Claude subscription this runs on");
const connectText = (a: ClaudeAccount) =>
  a.kind === "hub"
    ? "Save the hub's API key on the Hub pages of the app's Settings"
    : "Connect the subscription in Settings › Your accounts › Claude";

/** The hub's Claude setup at one moment: what a launch's account is decided from. */
export class Setup {
  constructor(
    readonly hubApi: ClaudeHubApi | undefined,
    readonly settings: ClaudeSettings,
    readonly subscriptions: Map<string, ClaudeSubscription>,
    readonly choices: Map<string, ClaudeChoice>,
    /** The first owner still on the hub. */
    readonly owner: string | undefined,
    readonly roles: Map<string, HubRole>,
  ) {}

  /** Anything at all is set up: else every machine runs on its own `claude login`. */
  configured(): boolean {
    return this.hubApi !== undefined || this.subscriptions.size > 0;
  }

  private hubHeld = () => this.hubApi?.sealedOn.map((s) => s.machineId);
  private subscriptionHeld = (person: string) => this.subscriptions.get(person)?.sealedOn.map((s) => s.machineId);

  /** The hub's API is the person's to use: it is set up, and they administer the hub or members may use it. */
  mayUseHubApi(person: string): boolean {
    const role = this.roles.get(person);
    return this.hubApi !== undefined && (this.settings.membersUseHubApi || (role !== undefined && administers(role)));
  }

  /**
   * What `whose` work runs on, on `machine` (undefined: on any machine holding it): the first of its ways that is set
   * up, theirs to use and held on the machine. One set up but on no such machine refuses the work there rather than
   * run it on the machine's own login.
   */
  runsOn(whose: Whose, machine?: string): ClaudeRunsOn {
    if (!this.configured()) return { kind: "machine_login" };
    const hub: Way = { account: { kind: "hub" }, held: this.hubHeld() };
    let ways: Way[];
    if ("hub" in whose) {
      ways = [hub];
      if (this.owner !== undefined) {
        ways.push({ account: { kind: "person", personId: this.owner }, held: this.subscriptionHeld(this.owner) });
      }
    } else {
      const person = whose.person;
      const own: Way = { account: { kind: "person", personId: person }, held: this.subscriptionHeld(person) };
      const theHub: Way = {
        ...hub,
        ...(this.hubApi !== undefined && !this.mayUseHubApi(person) ? { barred: "members may not use the hub's API on this hub" } : {}),
      };
      const choice = this.choices.get(person);
      ways = choice === "subscription" ? [own] : choice === "hub_api" ? [theHub] : [own, theHub];
    }
    const usable = ways.filter((w): w is Way & { held: string[] } => w.barred === undefined && w.held !== undefined);
    const onMachine = usable.find((w) => (machine === undefined ? w.held.length > 0 : w.held.includes(machine)));
    if (onMachine) return { kind: "account", account: onMachine.account };
    // Set up, but not on this machine: refused there, never run on the machine's own login instead.
    const first = usable[0];
    if (first) {
      const [place, when] =
        machine !== undefined ? [`on ${machine}`, `while ${machine} is online`] : ["on any machine", "while the machines are online"];
      return { kind: "refused", message: `${accountText(first.account)} isn't ${place}.`, fix: `${connectText(first.account)} again ${when}.` };
    }
    // Only members' subscriptions are set up: projects' leads keep the machines' own login.
    if ("hub" in whose) return { kind: "machine_login" };
    return { kind: "refused", message: CONNECT_REFUSAL, fix: this.connectFix(whose.person) };
  }

  /** What someone with no way to run does, in their own settings. */
  private connectFix(person: string): string {
    const subscribe =
      "connect your subscription in Settings › Your accounts › Claude (paste the token `claude setup-token` prints)";
    const choice = this.choices.get(person);
    if (choice === "hub_api" && this.hubApi === undefined) {
      return `The hub has no API key yet: ${subscribe}, or ask an admin to add one on the Hub pages of the app's Settings.`;
    }
    if (choice === "hub_api") return `Members may not use the hub's API on this hub: ${subscribe}, or ask an admin.`;
    if (this.hubApi !== undefined && !this.mayUseHubApi(person)) return `Members may not use the hub's API on this hub: ${subscribe}.`;
    return `Open Settings › Your accounts › Claude and ${subscribe}.`;
  }

  /** A person's setup as the tools show it. */
  person(person: Person): PersonClaude {
    const id = person.personId;
    const choice = this.choices.get(id);
    const subscription = this.subscriptions.get(id);
    return {
      person: refOf(person),
      ...(choice !== undefined ? { choice } : {}),
      ...(subscription !== undefined ? { subscription } : {}),
      mayUseHubApi: this.mayUseHubApi(id),
      runsOn: this.runsOn({ person: id }),
    };
  }
}

/** The person behind a Navi: its owner, else the hub's owner (a Navi from a hub without people yet). */
function naviOwner(db: HubDb, r: ProjectRef, owner: string | undefined): string | undefined {
  const row = db.conn
    .query<{ owner_person: string | null }, [string, string]>(
      "SELECT owner_person FROM project_settings WHERE machine_id = ? AND project_id = ? AND only_me = 1",
    )
    .get(r.machineId, r.projectId);
  if (!row) return undefined;
  return row.owner_person ?? owner;
}

/** The person who started order `id` (its workstream record's `startedBy`). */
function startedBy(db: HubDb, id: string): string | undefined {
  const n = /^W([1-9][0-9]{0,9})$/.exec(id)?.[1];
  if (n === undefined) return undefined;
  const row = db.conn.query<{ data: string }, [number]>("SELECT data FROM workstreams WHERE n = ?").get(Number(n));
  return parse<{ startedBy?: { personId?: string } }>(row?.data)?.startedBy?.personId;
}

/**
 * Whose work a task of `order` in project `r` is: a Navi's owner's in a Navi, else the person who started the order,
 * else nobody's (the hub's). A person since removed counts as nobody.
 */
export function whoseForTask(db: HubDb, setup: Setup, r: ProjectRef, order?: string): Whose {
  const navi = naviOwner(db, r, setup.owner);
  if (navi !== undefined) return { person: navi };
  const started = order !== undefined ? startedBy(db, order) : undefined;
  return started !== undefined && setup.roles.has(started) ? { person: started } : { hub: true };
}

/** Whose work a lead is: a Navi's lead its owner's, a project's lead the hub's. */
export function whoseForLead(db: HubDb, setup: Setup, r: ProjectRef): Whose {
  const navi = naviOwner(db, r, setup.owner);
  return navi !== undefined ? { person: navi } : { hub: true };
}

/** Why a launch can't run, and what to do. */
export type Refusal = { message: string; fix: string };

const unread = (error: unknown): Refusal => ({
  message: `The hub could not read its Claude accounts: ${error instanceof Error ? error.message : String(error)}.`,
  fix: "Try again; if it keeps failing, run fleetd doctor on the hub.",
});

/** What a machine's node said of Claude accounts in its hello. */
export type NodeAccounts = "runs" | "too_old" | "offline";

/** What `whose` work on `machine` runs on: undefined for the machine's own login; a Refusal when it can't run. */
export function launchAccount(setup: Setup, whose: Whose, machine: string, node: () => NodeAccounts): ClaudeAccount | undefined | Refusal {
  const on = setup.runsOn(whose, machine);
  if (on.kind === "machine_login") return undefined;
  if (on.kind === "refused") return { message: on.message, fix: on.fix };
  const state = node();
  if (state === "runs") return on.account;
  if (state === "too_old") {
    return { message: `${machine}'s node is too old to run work on a Claude account.`, fix: `Run fleetd update on ${machine}.` };
  }
  return {
    message: `${machine}'s node is offline, so no work starts there.`,
    fix: `It starts once ${machine}'s node links again: check that fleetd's node runs there.`,
  };
}

export const isRefusal = (v: ClaudeAccount | undefined | Refusal): v is Refusal => v !== undefined && "message" in v;

/** `launchAccount` for a task of `order` in project `r` on `machine`. */
export function forTask(db: HubDb, node: (m: string) => NodeAccounts, r: ProjectRef, order: string | undefined, machine: string) {
  try {
    const setup = new ClaudeAccountStore(db).setup();
    return launchAccount(setup, whoseForTask(db, setup, r, order), machine, () => node(machine));
  } catch (e) {
    return unread(e);
  }
}

/** `launchAccount` for the lead of project `r` on its machine. */
export function forLead(db: HubDb, node: (m: string) => NodeAccounts, r: ProjectRef) {
  try {
    const setup = new ClaudeAccountStore(db).setup();
    return launchAccount(setup, whoseForLead(db, setup, r), r.machineId, () => node(r.machineId));
  } catch (e) {
    return unread(e);
  }
}

/** The refusal an order would meet anywhere, before any agent is spawned for it. */
export function orderRefusal(db: HubDb, r: ProjectRef, order: string): Refusal | undefined {
  try {
    const setup = new ClaudeAccountStore(db).setup();
    const on = setup.runsOn(whoseForTask(db, setup, r, order));
    return on.kind === "refused" ? { message: on.message, fix: on.fix } : undefined;
  } catch (e) {
    return unread(e);
  }
}

/** The key of the account a task would run on, on `machine`: whose usage pause holds it. */
export function taskAccountKey(db: HubDb, r: ProjectRef, order: string | undefined, machine: string): string | undefined {
  try {
    const setup = new ClaudeAccountStore(db).setup();
    const on = setup.runsOn(whoseForTask(db, setup, r, order), machine);
    return on.kind === "account" ? accountKey(on.account) : undefined;
  } catch {
    return undefined;
  }
}

/** The key of the account the lead of project `r` runs on. */
export function leadAccountKey(db: HubDb, r: ProjectRef): string | undefined {
  try {
    const setup = new ClaudeAccountStore(db).setup();
    const on = setup.runsOn(whoseForLead(db, setup, r), r.machineId);
    return on.kind === "account" ? accountKey(on.account) : undefined;
  } catch {
    return undefined;
  }
}
