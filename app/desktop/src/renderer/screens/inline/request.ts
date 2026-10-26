// What the two inline chat items say, as pure functions: where a secret lands and whether it can be sealed now, the
// exact command an approval runs, and the one result line under it.
import type { ChatItem, CommandApprovalItem, GatedClass, GatedRunSpec, HumanRequest, Machine, SecretRequestItem } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { shortElapsed } from "../chat/format";

/**
 * The item as the hub's request says it is now. A request's changes arrive as request.updated events (and a fresh
 * requests_list), not as a new chat message, so the request wins over the item it was posted as: its state, the
 * secret's fingerprint, an approval's exit code, output and the one-line evidence (why it is open again, or failed).
 */
export const withRequest = (item: ChatItem, request: HumanRequest | undefined): ChatItem => {
  if (request === undefined || request.requestId !== item.requestId) return item;
  // As the hub's own item (approvals::chat_item): the evidence is a note only while it explains why the request is
  // open again or failed. Otherwise it is bookkeeping, a fingerprint or "exit 0 …", which the item already says.
  const explains = request.state === "open" || request.state === "failed";
  const firstLine = request.evidence?.split("\n")[0]?.trim();
  const note = explains && firstLine !== undefined && firstLine !== "" ? { note: firstLine } : {};
  if (item.kind === "secret_request") {
    const fingerprint = request.secret?.fingerprint;
    return { ...item, state: request.state, ...note, ...(fingerprint === undefined ? {} : { fingerprint }) };
  }
  return {
    ...item,
    state: request.state,
    ...note,
    ...(request.exitCode === undefined ? {} : { exitCode: request.exitCode }),
    ...(request.outputTail === undefined ? {} : { outputTail: request.outputTail }),
    ...(request.answeredAt === undefined ? {} : { answeredAt: request.answeredAt }),
    ...(request.finishedAt === undefined ? {} : { finishedAt: request.finishedAt }),
  };
};

export type SecretTarget =
  | { readonly ok: true; readonly machine: string; readonly boxPubKey: string; readonly where: string }
  | { readonly ok: false; readonly message: string; readonly fix: string }
  /** No fresh connection: the machines aren't known now (a launch from the disk cache holds none), so none is checked. */
  | { readonly ok: false; readonly offline: true };

/** The one line an open item says while there is no fresh connection: nothing can be answered now. */
export const OFFLINE_LINE = { secret: "Offline: save it once the hub is back.", approval: "Offline: approve once the hub is back." } as const;

/** Why an open approval can't be answered now, or undefined when it can. */
export const approvalOffline = (state: string, live: boolean): string | undefined =>
  state === "open" && !live ? OFFLINE_LINE.approval : undefined;

/** secrets.rs parse_secret_sink, as far as the item needs it: the machine and the path, or an order sink's order. */
const SINK = /^(env|file):([a-z0-9-]{1,32}):(\/[^\n\r]*)$/u;
const ORDER_SINK = /^(order):([a-z0-9-]{1,32}):(W[1-9][0-9]{0,9})$/u;

/** Where a secret goes and the key to seal it to, or why it can't be sent now and what to do. */
export const secretTarget = (machines: Readonly<Record<string, Machine>>, item: SecretRequestItem, live = true): SecretTarget => {
  const [, kind, machineId, path] = SINK.exec(item.sink) ?? ORDER_SINK.exec(item.sink) ?? [];
  if (kind === undefined || machineId === undefined || path === undefined) {
    return { ok: false, message: "The lead didn't say where this secret goes.", fix: "Tell the lead in the chat; it can ask again with a destination." };
  }
  if (!live) return { ok: false, offline: true };
  const machine = machines[machineId];
  if (machine === undefined) {
    return { ok: false, message: `fleetd doesn't know the machine ${machineId}.`, fix: "Add that machine first, or tell the lead in the chat." };
  }
  if (machine.boxPubKey === undefined) {
    return { ok: false, message: `${machine.name} takes no secrets yet: its node has no box key.`, fix: `Update fleetd on ${machine.name}, then save it.` };
  }
  if (machine.status === "offline") {
    return { ok: false, message: `${machine.name} is offline.`, fix: `Save it once ${machine.name} is back online.` };
  }
  const where =
    kind === "order"
      ? `${item.envName === undefined ? "" : `as ${item.envName} `}for ${path}'s agents on ${machine.name}, until the order closes`
      : kind === "env"
        ? `${item.envName === undefined ? "" : `as ${item.envName} `}in ${path} on ${machine.name}`
        : `to ${path} on ${machine.name}`;
  return { ok: true, machine: machine.name, boxPubKey: machine.boxPubKey, where };
};

/** argv as one line a person can read and paste, quoting only the arguments that need it. */
export const shellLine = (argv: readonly string[]): string =>
  argv.map((a) => (/^[\w@%+=:,./-]+$/u.test(a) ? a : `'${a.replace(/'/gu, `'\\''`)}'`)).join(" ");

/** The secrets a command is started with, by name: the variable and the stored secret it comes from, never a value. */
export const secretEnvLines = (gated: GatedRunSpec): string[] =>
  (gated.secretEnv ?? []).map((e) => `\`${e.name}\` gets the secret \`${e.secretKey}\``);

/** The class in plain words; every gated command raises the stakes, so it always has one. */
export const classWords = (c: GatedClass): string =>
  c === "irreversible" ? "Can't be undone" : c === "money" ? "Costs money" : "Uses a credential";

export type Outcome = { readonly tone: "quiet" | "success" | "danger" | "warning"; readonly text: string };

/** A state from a newer hub: no raw word, just what to do. */
const NEWER: Outcome = { tone: "quiet", text: "Changed in a newer fleetd. Update the app to see it." };

/** From the approval to the result, when the hub recorded both. */
const took = (item: CommandApprovalItem): string | undefined => {
  const from = item.answeredAt === undefined ? Number.NaN : Date.parse(item.answeredAt);
  const to = item.finishedAt === undefined ? Number.NaN : Date.parse(item.finishedAt);
  return Number.isNaN(from) || Number.isNaN(to) || to < from ? undefined : shortElapsed(to - from);
};

/** The one line an answered approval folds to, or undefined while it waits for Approve / Deny. */
export const approvalOutcome = (item: CommandApprovalItem): Outcome | undefined => {
  const time = took(item);
  switch (item.state) {
    case "open":
      return undefined;
    case "approved":
      return { tone: "quiet", text: "Approved, running…" };
    case "ran": {
      // No exit code: a signal or the timeout ended it.
      if (item.exitCode === undefined) return { tone: "warning", text: time === undefined ? "Approved, stopped before it finished" : `Approved, stopped after ${time}` };
      const ran = time === undefined ? "Approved and ran" : `Approved, ran in ${time}`;
      return item.exitCode === 0 ? { tone: "success", text: ran } : { tone: "danger", text: `${ran} · exit ${String(item.exitCode)}` };
    }
    case "failed":
      return { tone: "danger", text: "Approved, didn't run" };
    case "denied":
      return { tone: "quiet", text: "Denied, nothing ran" };
    default:
      return NEWER;
  }
};

/** The one line an answered secret folds to, or undefined while it waits. */
export const secretOutcome = (item: SecretRequestItem): Outcome | undefined => {
  // The fingerprint stays in the data: a raw hash is never UI text.
  if (item.state === "stored") return { tone: "success", text: "Secret saved" };
  if (item.state === "withdrawn") return { tone: "quiet", text: "Not needed any more" };
  if (item.state === "open") return undefined;
  return NEWER;
};

/** Only a command that can't be undone asks once more before it runs. */
export const needsConfirm = (item: CommandApprovalItem): boolean => item.gated?.class === "irreversible";

/** The lead's line without its code marks, for a folded row's plain text. */
const plain = (text: string): string => text.replace(/`/gu, "");

/** What an answered approval was about, as one plain line for its folded row. */
export const approvalTitle = (item: CommandApprovalItem): string =>
  plain(item.gated?.reason ?? (item.permission === undefined ? "An agent's request" : `An agent wanted to use ${item.permission.toolName}`));

/** What an answered secret was for, in the lead's words: its key is a slug, never row text. */
export const secretTitle = (item: SecretRequestItem): string => plain(item.text);

export type Action = "approve" | "deny" | "save";
export type Failure = { readonly text: string; readonly retry: boolean };

/**
 * A failed answer as one plain sentence, by the error's code. The hub's own message never shows: it names request
 * ids and tools, and a fixture's or a newer hub's can be anything. Retry only where trying again can help.
 */
export const failureLine = (action: Action, error: Pick<HubError, "code">, machine: string): Failure => {
  const not = action === "save" ? "Not saved" : action === "approve" ? "Not approved" : "Not denied";
  switch (error.code) {
    case "offline":
    case "disconnected":
      return { text: `${not}: you're offline.`, retry: true };
    case "timeout":
      return { text: `${not}: no answer in time.`, retry: true };
    case "machine_offline":
      return { text: `${not}: ${machine} is offline.`, retry: true };
    case "forbidden":
      return { text: `${not}: this computer can't answer for ${machine}.`, retry: false };
    case "not_found":
      return { text: `${not}: it's no longer open.`, retry: false };
    case "invalid":
      return action === "save" ? { text: "Not saved: check the value and try again.", retry: true } : { text: `${not}: it was already answered.`, retry: false };
    default:
      return { text: `${not}: something went wrong.`, retry: true };
  }
};
