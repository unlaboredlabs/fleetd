// Which Claude account each agent runs on (teams step 8, D200). The
// hub keeps the hub's API configuration, each person's subscription and choice, and the hub-wide switch, with each
// node's fingerprint and never a key or token (`claude_accounts`, `claude_choices`, `claude_settings`).
//
// At each launch the hub works out whose work it is (`whoseForTask`, `whoseForLead`) and what that runs on
// (`Setup.runsOn`), sends the account in the launch and records it per thread (`thread_accounts`).
import type {
  GeminiKey,
  ClaudeAccount,
  ClaudeChoice,
  ClaudeHubApi,
  ClaudeSealedOn,
  ClaudeSettings,
  ClaudeSubscription,
  ClaudeTest,
  ProjectRef,
} from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import { activePeople } from "./people.ts";
import { accountFromKey, accountKey, launchAccount, type NodeAccounts, type Refusal, Setup, type Whose } from "./setup.ts";

export {
  accountFromKey,
  accountKey,
  CONNECT_REFUSAL,
  isRefusal,
  launchAccount,
  type NodeAccounts,
  type Refusal,
  Setup,
  type Whose,
} from "./setup.ts";

const HUB = "hub";
/** The team's Gemini key's row: no person id looks like it. */
const GEMINI = "gemini";
/** What each account keeps of the machines: where it is held, and its last Test. */
type Held = { sealedOn: ClaudeSealedOn[]; lastTest?: ClaudeTest | null };
const MEMBERS_USE_HUB_API = "members_use_hub_api";
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

  private get<T extends Held>(account: string): T | undefined {
    const row = this.db.conn.query<{ data: string }, [string]>("SELECT data FROM claude_accounts WHERE account = ?").get(account);
    const held = parse<T>(row?.data);
    return held && this.present(held);
  }

  /** The account as the machines there are now hold it: a machine removed since (a cloud machine, say) neither holds
   * it nor tested it, so its last Test is not the account's current result. */
  private present<T extends Held>(held: T): T {
    const machines = new Set(this.db.conn.query<{ machine_id: string }, []>("SELECT machine_id FROM machines").all().map((r) => r.machine_id));
    const out = { ...held, sealedOn: held.sealedOn.filter((s) => machines.has(s.machineId)) };
    if (held.lastTest && !machines.has(held.lastTest.machineId)) delete out.lastTest;
    return out;
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
  /** The team's Gemini API key (gemini_key_set): kept as the hub's API key is, never the key, only where it is. */
  geminiKey = () => this.get<GeminiKey>(GEMINI);
  putGeminiKey = (key: GeminiKey) => this.put(GEMINI, key);
  removeGeminiKey = () => this.remove(GEMINI);
  removeHubApi = () => this.remove(HUB);
  subscription = (person: string) => this.get<ClaudeSubscription>(person);
  putSubscription = (person: string, s: ClaudeSubscription) => this.put(person, s);
  removeSubscription = (person: string) => this.remove(person);

  /** Every connected subscription, by person. */
  subscriptions(): Map<string, ClaudeSubscription> {
    const rows = this.db.conn
      .query<{ account: string; data: string }, [string, string]>("SELECT account, data FROM claude_accounts WHERE account NOT IN (?, ?)")
      .all(HUB, GEMINI);
    const out = new Map<string, ClaudeSubscription>();
    for (const r of rows.sort((a, b) => (a.account < b.account ? -1 : 1))) {
      const s = parse<ClaudeSubscription>(r.data);
      if (s) out.set(r.account, this.present(s));
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

/** The person who started order `id` (its workstream record's `startedBy`). */
function startedBy(db: HubDb, id: string): string | undefined {
  const n = /^W([1-9][0-9]{0,9})$/.exec(id)?.[1];
  if (n === undefined) return undefined;
  const row = db.conn.query<{ data: string }, [number]>("SELECT data FROM workstreams WHERE n = ?").get(Number(n));
  return parse<{ startedBy?: { personId?: string } }>(row?.data)?.startedBy?.personId;
}

/**
 * Whose work a task of `order` is: the person who started the order, else nobody's (the hub's). A person since removed
 * counts as nobody.
 */
export function whoseForTask(db: HubDb, setup: Setup, order?: string): Whose {
  const started = order !== undefined ? startedBy(db, order) : undefined;
  return started !== undefined && setup.roles.has(started) ? { person: started } : { hub: true };
}

/** Whose work a lead is: every project's lead is the hub's (D491). */
export const whoseForLead = (): Whose => ({ hub: true });

const unread = (error: unknown): Refusal => ({
  message: `The hub could not read its Claude accounts: ${error instanceof Error ? error.message : String(error)}.`,
  fix: "Try again; if it keeps failing, run fleetd doctor on the hub.",
});

/** `launchAccount` for a task of `order` in project `r` on `machine`. */
export function forTask(db: HubDb, node: (m: string) => NodeAccounts, r: ProjectRef, order: string | undefined, machine: string) {
  try {
    const setup = new ClaudeAccountStore(db).setup();
    return launchAccount(setup, whoseForTask(db, setup, order), machine, () => node(machine));
  } catch (e) {
    return unread(e);
  }
}

/** `launchAccount` for the lead of project `r` on its machine. */
export function forLead(db: HubDb, node: (m: string) => NodeAccounts, r: ProjectRef) {
  try {
    const setup = new ClaudeAccountStore(db).setup();
    return launchAccount(setup, whoseForLead(), r.machineId, () => node(r.machineId));
  } catch (e) {
    return unread(e);
  }
}

/** The refusal an order would meet anywhere, before any agent is spawned for it. */
export function orderRefusal(db: HubDb, r: ProjectRef, order: string): Refusal | undefined {
  try {
    const setup = new ClaudeAccountStore(db).setup();
    const on = setup.runsOn(whoseForTask(db, setup, order));
    return on.kind === "refused" ? { message: on.message, fix: on.fix } : undefined;
  } catch (e) {
    return unread(e);
  }
}

/** The key of the account a task would run on, on `machine`: whose usage pause holds it. */
export function taskAccountKey(db: HubDb, r: ProjectRef, order: string | undefined, machine: string): string | undefined {
  try {
    const setup = new ClaudeAccountStore(db).setup();
    const on = setup.runsOn(whoseForTask(db, setup, order), machine);
    return on.kind === "account" ? accountKey(on.account) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether some task of bot `r` may run on a Claude account on `machine`: the one a task nobody started gets, or any
 * person's subscription there (a task a person starts runs on theirs). Its agents' computer choices that take only
 * accounts are offered then; the slot board still holds an agent that has none, saying why.
 */
export function anyTaskAccount(db: HubDb, r: ProjectRef, machine: string): boolean {
  if (taskAccountKey(db, r, undefined, machine) !== undefined) return true;
  try {
    for (const s of new ClaudeAccountStore(db).subscriptions().values()) if (s.sealedOn.some((x) => x.machineId === machine)) return true;
  } catch {}
  return false;
}

/** The key of the account the lead of project `r` runs on. */
export function leadAccountKey(db: HubDb, r: ProjectRef): string | undefined {
  try {
    const setup = new ClaudeAccountStore(db).setup();
    const on = setup.runsOn(whoseForLead(), r.machineId);
    return on.kind === "account" ? accountKey(on.account) : undefined;
  } catch {
    return undefined;
  }
}
