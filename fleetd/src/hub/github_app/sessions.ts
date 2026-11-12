// An order's agents on GitHub (D187). On a repository the hub's App
// reaches, an order's sessions get `GH_TOKEN`: its starter's own token (people.ts), so the PRs its agents open are that
// person's, or, for work nobody started, the App's own installation token. It travels as one of the order's variables
// (an `order:` sink) at each repo's checkout: sealed to the checkout machine's box key, masked in what the agents
// report, read again at each command, and dropped with the order's other variables when it closes. The hub delivers it
// at each task launch (`deliver`) and checks every order's on each sweep (`renew`), from what it keeps in
// `github_order_tokens`, so running agents keep getting fresh tokens across a hub restart.
//
// Never anyone else's account (D187). A writer whose order's starter hasn't connected GitHub is refused at spawn
// (`refusal`) and at launch. When a person's token is taken back (they disconnect, GitHub lapses it, or they leave
// the hub), their orders' agents get `BLOCKED_TOKEN` in its place, so `gh` fails there rather than run on the
// machine's own login, and the order's lead is told. A token that ends before the hub could renew it is replaced with
// `UNRENEWED_TOKEN` until a sweep renews it. Only where the App doesn't reach do agents use the machine's own login.
import type { MachineId, PersonId, ProjectRef, RepoId, TaskKind, WorkstreamId } from "../../shared/contracts.ts";
import { publicKeyOf, seal } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import * as seams from "../train/seams.ts";
import { GITHUB_CONNECT_REFUSAL, GITHUB_TOKEN_ENV, githubApps } from "./index.ts";
import { account, disconnect, SESSION_MARGIN_MS, userToken } from "./people.ts";
import { type Block, BLOCKED_TOKEN, blockedLine, CAP_ORDER_ENV, TOKEN_PENDING, UNRENEWED_TOKEN } from "./session_rules.ts";

export { type Block, BLOCKED_TOKEN, blockedLine, CAP_ORDER_ENV, TOKEN_PENDING, UNRENEWED_TOKEN } from "./session_rules.ts";

/** An App token handed to sessions has at least this long left; it is delivered again once it has less. */
const APP_MARGIN_MS = 30 * 60_000;
/** What the hub keeps under an order's variables for its token, in place of a request id. */
const REQUEST_ID = "github";
/** Whose GitHub an order's agents use: the person who started it, or the App's own. */
export type GithubAs = { kind: "person"; person: PersonId } | { kind: "app" };

/** An order's delivered token, as `github_order_tokens` keeps it. */
export type Kept = {
  /** The order's project. */
  r: ProjectRef;
  order: WorkstreamId;
  checkout: ProjectRef;
  repoId?: RepoId;
  person?: PersonId;
  expiresMs: number;
  marginMs: number;
  /** The agents hold a placeholder: `BLOCKED_TOKEN` or `UNRENEWED_TOKEN`. */
  blocked: boolean;
};

/** Logs that `what` failed for the order's token at `checkout`, once per change of why; undefined: a try that worked. */
function warnOnce(hub: Hub, checkout: ProjectRef, order: WorkstreamId, what: string, e: string | undefined): void {
  const warned = githubApps(hub).warned;
  const key = `${seams.refKey(checkout)}\u0000${order}\u0000${what}`;
  if (e === undefined) {
    warned.delete(key);
  } else if (warned.get(key) !== e) {
    console.warn(`github: ${what}: ${e} (order ${order})`);
    warned.set(key, e);
  }
}

export function keep(hub: Hub, k: Kept): void {
  hub.db.conn
    .query(
      `INSERT INTO github_order_tokens (machine_id, project_id, workstream_id, checkout_machine_id,
         checkout_project_id, repo_id, person_id, expires_ms, margin_ms, blocked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workstream_id, checkout_machine_id, checkout_project_id) DO UPDATE SET
         repo_id = excluded.repo_id, person_id = excluded.person_id, expires_ms = excluded.expires_ms,
         margin_ms = excluded.margin_ms, blocked = excluded.blocked`,
    )
    .run(
      k.r.machineId,
      k.r.projectId,
      k.order,
      k.checkout.machineId,
      k.checkout.projectId,
      k.repoId ?? null,
      k.person ?? null,
      k.expiresMs,
      k.marginMs,
      k.blocked ? 1 : 0,
    );
}

function forget(hub: Hub, checkout: ProjectRef, order: WorkstreamId): void {
  const prefix = `${seams.refKey(checkout)}\u0000${order}\u0000`;
  const warned = githubApps(hub).warned;
  for (const key of [...warned.keys()]) if (key.startsWith(prefix)) warned.delete(key);
  try {
    hub.db.conn
      .query("DELETE FROM github_order_tokens WHERE workstream_id = ? AND checkout_machine_id = ? AND checkout_project_id = ?")
      .run(order, checkout.machineId, checkout.projectId);
  } catch (error) {
    console.warn(`github: the order's token not forgotten: ${error} (order ${order})`);
  }
}

type KeptRow = {
  machine_id: string;
  project_id: string;
  workstream_id: string;
  checkout_machine_id: string;
  checkout_project_id: string;
  repo_id: string | null;
  person_id: string | null;
  expires_ms: number;
  margin_ms: number;
  blocked: number;
};

/** Every order's delivered token. */
export function kept(hub: Hub): Kept[] {
  return hub.db.conn
    .query<KeptRow, []>(
      `SELECT machine_id, project_id, workstream_id, checkout_machine_id, checkout_project_id, repo_id, person_id,
         expires_ms, margin_ms, blocked
       FROM github_order_tokens ORDER BY workstream_id, checkout_machine_id, checkout_project_id`,
    )
    .all()
    .map((row) => {
      const k: Kept = {
        r: { machineId: row.machine_id, projectId: row.project_id },
        order: row.workstream_id,
        checkout: { machineId: row.checkout_machine_id, projectId: row.checkout_project_id },
        expiresMs: row.expires_ms,
        marginMs: row.margin_ms,
        blocked: row.blocked !== 0,
      };
      if (row.repo_id !== null) k.repoId = row.repo_id;
      if (row.person_id !== null) k.person = row.person_id;
      return k;
    });
}

/** The task's repository on GitHub (`owner/name`), and the checkout its sessions run in. */
export function repoAt(hub: Hub, r: ProjectRef, repoId?: RepoId): { repo: string; checkout: ProjectRef } | undefined {
  let repos;
  try {
    repos = seams.reposOf(hub.db.conn, r);
  } catch {
    return undefined;
  }
  const repo =
    repoId !== undefined ? repos.find((x) => x.repoId === repoId) : (repos.find((x) => seams.sameRef(x.checkout, r)) ?? repos[0]);
  const key = repo?.repoKey;
  if (!repo || key === undefined || !key.startsWith("github.com/")) return undefined;
  return { repo: key.slice("github.com/".length), checkout: repo.checkout };
}

export const repoOf = (hub: Hub, r: ProjectRef, repoId?: RepoId) => repoAt(hub, r, repoId)?.repo;

/**
 * Whose work a task of `order` is (claude_accounts `whose_for_task`): the person who started the order (while on the
 * hub), else nobody's: the hub's.
 */
function whoseForTask(hub: Hub, order?: WorkstreamId): PersonId | undefined {
  const active = seams.people.active(hub.db.conn);
  const started = order === undefined ? undefined : seams.workstream(hub.db.conn, order)?.startedBy;
  return started && active.some((p) => p.personId === started.personId) ? started.personId : undefined;
}

/** Whose GitHub the order's agents use on `repo`; undefined when the App doesn't reach it. */
export function githubAs(hub: Hub, r: ProjectRef, order: WorkstreamId | undefined, repo: string): GithubAs | undefined {
  if (!githubApps(hub).reaches(repo)) return undefined;
  try {
    const person = whoseForTask(hub, order);
    return person === undefined ? { kind: "app" } : { kind: "person", person };
  } catch {
    return undefined;
  }
}

const nameOf = (hub: Hub, person: PersonId | undefined) =>
  (person === undefined ? undefined : seams.people.get(hub.db.conn, person)?.name) ?? "The person who started it";

/**
 * Why a task of `kind` can't be spawned for the order: a writer, on a repository the App reaches, for a person who
 * hasn't connected GitHub (or whose connection lapsed). The message, and its fix.
 */
export function refusal(
  hub: Hub,
  r: ProjectRef,
  order: WorkstreamId,
  kind: TaskKind,
  repoId?: RepoId,
): { message: string; fix: string } | undefined {
  if (kind !== "write") return undefined;
  const repo = repoOf(hub, r, repoId);
  if (repo === undefined) return undefined;
  const as = githubAs(hub, r, order, repo);
  if (as?.kind !== "person") return undefined;
  const name = nameOf(hub, as.person);
  let a;
  try {
    a = account(githubApps(hub), as.person);
  } catch {
    a = undefined;
  }
  if (a && a.lapsed !== true) return undefined;
  if (a) {
    return {
      message: `GitHub no longer takes ${name}'s connection (${a.login}): connect GitHub again to open this order's PRs.`,
      fix: `Ask ${name} to press Connect again in Settings › Your accounts › GitHub in their fleetd app; then spawn the writer again.`,
    };
  }
  return {
    message: `${GITHUB_CONNECT_REFUSAL} ${name} started it and hasn't connected their GitHub, and its PRs open as them.`,
    fix: `Ask ${name} to connect GitHub in Settings › Your accounts › GitHub in their fleetd app (one sign-in); then spawn the writer again.`,
  };
}

/**
 * Hands the sessions of the order's task in that repo their GitHub token, when the App reaches it. Where it doesn't,
 * a token handed there before is withdrawn. Throws why it couldn't, for a launch to refuse rather than run as the
 * machine's login.
 */
export async function deliver(hub: Hub, r: ProjectRef, order: WorkstreamId, repoId: RepoId | undefined, writer: boolean): Promise<void> {
  await deliverOn(hub, r, order, repoId, writer, undefined);
}

/** `deliver`, for a task launched in the checkout `on`. */
export async function deliverOn(
  hub: Hub,
  r: ProjectRef,
  order: WorkstreamId,
  repoId: RepoId | undefined,
  writer: boolean,
  on: ProjectRef | undefined,
): Promise<void> {
  await hand(hub, r, order, repoId, writer, on, false);
}

/** `deliverOn` at a task's launch: GitHub giving no token now doesn't stop it; `TOKEN_PENDING` is what it is told. */
export async function deliverAtLaunch(
  hub: Hub,
  r: ProjectRef,
  order: WorkstreamId,
  repoId: RepoId | undefined,
  writer: boolean,
  on: ProjectRef,
): Promise<string | undefined> {
  return (await hand(hub, r, order, repoId, writer, on, true)) ? undefined : TOKEN_PENDING;
}

async function hand(
  hub: Hub,
  r: ProjectRef,
  order: WorkstreamId,
  repoId: RepoId | undefined,
  writer: boolean,
  on: ProjectRef | undefined,
  wait: boolean,
): Promise<boolean> {
  const at = repoAt(hub, r, repoId);
  if (!at) return true;
  const checkout = on && on.machineId !== at.checkout.machineId ? on : at.checkout;
  const github = githubAs(hub, r, order, at.repo);
  if (!github) {
    await withdrawAt(hub, checkout, order);
    return true;
  }
  const person = github.kind === "person" ? github.person : undefined;
  const marginMs = github.kind === "person" ? SESSION_MARGIN_MS : APP_MARGIN_MS;
  const pending: Kept = { r, order, checkout, expiresMs: hub.clock.now(), marginMs, blocked: true };
  if (repoId !== undefined) pending.repoId = repoId;
  if (person !== undefined) pending.person = person;
  const apps = githubApps(hub);
  let token: { token: string; expiresMs: number };
  if (github.kind === "person") {
    let got: { token: string; expiresMs: number } | undefined;
    let failed: string | undefined;
    try {
      got = await userToken(apps, github.person);
    } catch (error) {
      failed = (error as Error).message;
    }
    // A lapsed connection says so as a failure; any other (GitHub unreachable) is the launch's to report.
    let lapsed = false;
    try {
      lapsed = account(apps, github.person)?.lapsed === true;
    } catch {}
    if (got) {
      token = got;
    } else if (failed !== undefined && !lapsed && wait) {
      return waitForToken(hub, pending, failed);
    } else if (failed !== undefined && !lapsed) {
      throw new Error(failed);
    } else if (writer) {
      throw new Error(`${GITHUB_CONNECT_REFUSAL} Its starter connects GitHub in Settings › Your accounts › GitHub`);
    } else {
      // A reader or reviewer opens no PR: it goes on, but never on a token of theirs taken back.
      const k = keptAt(hub, checkout, order);
      if (k) await blockAt(hub, k, { kind: "disconnected" });
      return true;
    }
  } else {
    const got = await apps.installationToken(at.repo, APP_MARGIN_MS);
    if (!got) {
      const e = `GitHub gave the hub's App no token for ${at.repo}`;
      if (wait) return waitForToken(hub, pending, e);
      throw new Error(e);
    }
    token = got;
  }
  await put(hub, checkout, order, token.token);
  keep(hub, { ...pending, expiresMs: token.expiresMs, blocked: false });
  if (person !== undefined) await spread(hub, person, token.token, token.expiresMs);
  return true;
}

/** A launch GitHub gave no token for: its agents hold `UNRENEWED_TOKEN` under a blocked record the sweep renews. */
async function waitForToken(hub: Hub, pending: Kept, e: string): Promise<boolean> {
  const k = keptAt(hub, pending.checkout, pending.order);
  // The order's agents there hold one that still works: this one reads it too.
  if (k && !k.blocked && k.expiresMs > hub.clock.now()) return true;
  // They already wait for one.
  if (k?.blocked) return false;
  console.warn(`github: no token for the order's launch yet, the sweep delivers it: ${e} (order ${pending.order})`);
  await put(hub, pending.checkout, pending.order, UNRENEWED_TOKEN);
  keep(hub, pending);
  return false;
}

/** Hands a person's refreshed token to every other of their orders that holds the one before: the refresh ended it. */
async function spread(hub: Hub, person: PersonId, token: string, expiresMs: number): Promise<void> {
  for (const k of kept(hub).filter((k) => k.person === person && !k.blocked && k.expiresMs !== expiresMs)) {
    try {
      await put(hub, k.checkout, k.order, token);
      try {
        keep(hub, { ...k, expiresMs });
      } catch (error) {
        console.warn(`github: the refreshed token's record not kept: ${error} (order ${k.order})`);
      }
    } catch (error) {
      console.warn(`github: the refreshed token not handed over yet: ${(error as Error).message} (order ${k.order})`);
    }
  }
}

const keptAt = (hub: Hub, checkout: ProjectRef, order: WorkstreamId) =>
  kept(hub).find((k) => seams.sameRef(k.checkout, checkout) && k.order === order);

/**
 * Has the checkout's node forget the order's `GH_TOKEN`, if it holds one, and forgets it here once it has. A node
 * offline keeps the record, and the next sweep tries again.
 */
async function withdrawAt(hub: Hub, checkout: ProjectRef, order: WorkstreamId): Promise<void> {
  let held;
  try {
    held = seams.orderEnv.list(hub.db.conn, checkout, order).find((v) => v.name === GITHUB_TOKEN_ENV);
  } catch {
    held = undefined;
  }
  if (!held) return forget(hub, checkout, order);
  try {
    await orderEnvDrop(hub, checkout, order, GITHUB_TOKEN_ENV, held.fingerprint);
    try {
      seams.orderEnv.forgetOne(hub.db.conn, checkout, order, GITHUB_TOKEN_ENV);
    } catch (error) {
      console.warn(`github: the withdrawn token's row stays: ${error} (order ${order})`);
    }
    forget(hub, checkout, order);
  } catch (error) {
    warnOnce(hub, checkout, order, "the order's token not withdrawn yet", (error as Error).message);
  }
}

/** The node drops one of the order's variables (`SessionCall::OrderEnvDrop`). */
async function orderEnvDrop(hub: Hub, r: ProjectRef, order: WorkstreamId, name: string, fingerprint: string): Promise<void> {
  const reply = (await seams.link(hub).request(r.machineId, {
    t: "session_call",
    call: { op: "order_env_drop", projectId: r.projectId, orderId: order, name, fingerprint },
  } as never)) as unknown as Record<string, unknown>;
  const error = reply.error as { message?: string } | string | undefined;
  if (error !== undefined && error !== null) throw new Error(typeof error === "string" ? error : (error.message ?? JSON.stringify(error)));
}

/** Takes a token back from one order's agents: they get a placeholder GitHub refuses, and the lead is told why. */
async function blockAt(hub: Hub, k: Kept, why: Block): Promise<void> {
  const TAKEN_BACK = "the order's token not taken back yet";
  if (k.blocked) return;
  try {
    await put(hub, k.checkout, k.order, why.kind === "disconnected" ? BLOCKED_TOKEN : UNRENEWED_TOKEN);
  } catch (error) {
    return warnOnce(hub, k.checkout, k.order, TAKEN_BACK, (error as Error).message);
  }
  warnOnce(hub, k.checkout, k.order, TAKEN_BACK, undefined);
  try {
    keep(hub, { ...k, blocked: true });
  } catch (error) {
    console.warn(`github: the blocked token's record not kept: ${error} (order ${k.order})`);
  }
  const name = nameOf(hub, k.person);
  const text = blockedLine(k.order, name, why);
  seams.leadWakes(hub).trigger(k.r, { kind: "line", line: "request", text });
}

/** Takes a person's token back from every one of their open orders' agents: they disconnected, or left the hub. */
export async function withdrawPerson(hub: Hub, person: PersonId): Promise<void> {
  for (const k of kept(hub).filter((k) => k.person === person)) await blockAt(hub, k, { kind: "disconnected" });
}

/** A person leaves the hub: their GitHub token is revoked at GitHub and forgotten, and taken back from their orders. */
export async function forgetPerson(hub: Hub, person: PersonId): Promise<void> {
  try {
    await disconnect(githubApps(hub), person);
  } catch (error) {
    console.warn(`github: a removed person's token not revoked: ${(error as Error).message}`);
  }
  await withdrawPerson(hub, person);
}

/** Takes back every token the App handed out: it was removed. */
export async function withdrawAll(hub: Hub): Promise<void> {
  for (const k of kept(hub)) await withdrawAt(hub, k.checkout, k.order);
}

/** `token` sealed to machine `m`'s box key, standard base64: only its node opens it. */
export function sealedTo(hub: Hub, m: MachineId, token: string): string {
  const key = seams.machine(hub.db.conn, m)?.boxPubKey;
  if (key === undefined) throw new Error(`${m}'s node takes no secrets: it publishes no box key`);
  const pub = new Uint8Array(Buffer.from(key, "base64"));
  if (pub.length !== 32) throw new Error(`${m}'s box key isn't one`);
  return Buffer.from(seal(pub, new TextEncoder().encode(token))).toString("base64");
}

/** Seals `token` to the checkout machine's box key and has its node keep it as the order's `GH_TOKEN` there. */
async function put(hub: Hub, r: ProjectRef, order: WorkstreamId, token: string): Promise<void> {
  const m = r.machineId;
  if (!seams.machine(hub.db.conn, m)) {
    throw new Error(
      `${m} isn't one of the hub's machines now (removed, or enrolled again under another id): the token waits until it's back`,
    );
  }
  if (seams.nodeLacks(hub, m, CAP_ORDER_ENV)) throw new Error(`${m}'s node is too old to hand agents a GitHub token: update fleetd there`);
  if (!seams.nodeCan(hub, m, CAP_ORDER_ENV)) {
    throw new Error(`${m}'s node is offline: it gets the token at the first sweep after it links again`);
  }
  let result: Record<string, unknown>;
  try {
    result = (await seams.link(hub).commands.deliverSecret(m, {
      sink: `order:${m}:${order}`,
      sealed: sealedTo(hub, m, token),
      secretKey: "github.token",
      envName: GITHUB_TOKEN_ENV,
      projectId: r.projectId,
    })) as unknown as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${m}'s node didn't take the GitHub token: ${(error as Error).message}`);
  }
  const fingerprint = result.fingerprint;
  if (typeof fingerprint !== "string") {
    const e = result.error as { message?: string } | string | undefined;
    const words = e === undefined ? "" : typeof e === "string" ? e : (e.message ?? JSON.stringify(e));
    throw new Error(`${m}'s node didn't keep the GitHub token: ${words}`);
  }
  // Recorded as the order's other variables are, so it goes when the order closes.
  seams.orderEnv.save(hub.db.conn, r, order, {
    name: GITHUB_TOKEN_ENV,
    fingerprint,
    bytes: Buffer.byteLength(token),
    requestId: REQUEST_ID,
    updatedAt: seams.isoMs(hub.clock.now()),
  });
}

/**
 * Checks each open order's token on every sweep: withdrawn where the App no longer reaches, taken back from a person
 * no longer connected, delivered again within its margin of its end, and replaced by `UNRENEWED_TOKEN` once it ends
 * unrenewed. Forgets closed orders'.
 */
export async function renew(hub: Hub): Promise<void> {
  const now = hub.clock.now();
  const apps = githubApps(hub);
  for (const listed of kept(hub)) {
    // Read again: a refresh for an order before it in this sweep may have handed it its token already.
    const k = keptAt(hub, listed.checkout, listed.order);
    if (!k) continue;
    let open = false;
    try {
      const w = seams.workstream(hub.db.conn, k.order);
      open = w !== undefined && w.state === "open";
    } catch {}
    if (!open) {
      forget(hub, k.checkout, k.order);
      continue;
    }
    const at = repoAt(hub, k.r, k.repoId);
    if (!at || !apps.reaches(at.repo)) {
      await withdrawAt(hub, k.checkout, k.order);
      continue;
    }
    if (k.person !== undefined) {
      // Only the person's own state decides: a store that can't be read now decides nothing.
      let connected: boolean;
      try {
        const a = account(apps, k.person);
        connected = a !== undefined && a.lapsed !== true;
      } catch (error) {
        console.warn(`github: ${k.person}'s connection not read: ${error}`);
        continue;
      }
      if (!connected) {
        await blockAt(hub, k, { kind: "disconnected" });
        continue;
      }
    }
    if (!k.blocked && k.expiresMs - now >= k.marginMs) continue;
    const RENEWED = "the order's token not renewed";
    try {
      await deliverOn(hub, k.r, k.order, k.repoId, false, k.checkout);
      warnOnce(hub, k.checkout, k.order, RENEWED, undefined);
    } catch (error) {
      const e = (error as Error).message;
      warnOnce(hub, k.checkout, k.order, RENEWED, e);
      // Ended unrenewed: the agents are told so, never left to fall back to the machine's login.
      if (k.expiresMs <= now) await blockAt(hub, k, { kind: "not_renewed", why: e });
    }
  }
}

/** Renews the orders' tokens on every sweep. */
export function run(hub: Hub): void {
  seams.sweep(hub).register({ name: "github-tokens", run: () => renew(hub) });
}

/** The box key's public half, for tests that play a node. */
export const boxPublic = (secret: Uint8Array) => Buffer.from(publicKeyOf(secret)).toString("base64");
