// What the two inline chat items say, as pure functions: where a secret lands and whether it can be sealed now, the
// exact command an approval runs, and the one result line under it.
import type { ChatItem, CommandApprovalItem, GatedClass, GatedRunSpec, HumanRequest, Machine, SecretRequestItem } from "../../../shared/contracts";

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
  };
};

export type SecretTarget =
  | { readonly ok: true; readonly machine: string; readonly boxPubKey: string; readonly where: string }
  | { readonly ok: false; readonly message: string; readonly fix: string };

/** secrets.rs parse_secret_sink, as far as the item needs it: the machine and the path. */
const SINK = /^(env|file):([a-z0-9-]{1,32}):(\/[^\n\r]*)$/u;

/** Where a secret goes and the key to seal it to, or why it can't be sent now and what to do. */
export const secretTarget = (machines: Readonly<Record<string, Machine>>, item: SecretRequestItem): SecretTarget => {
  const [, kind, machineId, path] = SINK.exec(item.sink) ?? [];
  if (kind === undefined || machineId === undefined || path === undefined) {
    return { ok: false, message: "The lead didn't say where this secret goes.", fix: "Tell the lead in the chat; it can ask again with a destination." };
  }
  const machine = machines[machineId];
  if (machine === undefined) {
    return { ok: false, message: `The hub doesn't know the machine ${machineId}.`, fix: "Add that machine first, or tell the lead in the chat." };
  }
  if (machine.boxPubKey === undefined) {
    return { ok: false, message: `${machine.name} takes no secrets yet: its node has no box key.`, fix: `Update fleetd on ${machine.name}, then save it.` };
  }
  if (machine.status === "offline") {
    return { ok: false, message: `${machine.name} is offline.`, fix: `Save it once ${machine.name} is back online.` };
  }
  const where =
    kind === "env" ? `${item.envName === undefined ? "" : `as ${item.envName} `}in ${path} on ${machine.name}` : `to ${path} on ${machine.name}`;
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
const NEWER: Outcome = { tone: "quiet", text: "Changed on the hub. Update the app to see how." };

/** The result line under an approval, or undefined while it waits for Approve / Deny. */
export const approvalOutcome = (item: CommandApprovalItem): Outcome | undefined => {
  const exit = item.exitCode === undefined ? "" : ` · exit ${String(item.exitCode)}`;
  switch (item.state) {
    case "open":
      return undefined;
    case "approved":
      return { tone: "quiet", text: "Approved. Running…" };
    case "ran":
      return { tone: "success", text: `Ran${exit}` };
    case "failed":
      return { tone: "danger", text: `Failed${exit}` };
    case "denied":
      return { tone: "quiet", text: "Denied. Nothing ran." };
    default:
      return NEWER;
  }
};

/** The line under a secret once it is answered, or undefined while it waits. */
export const secretOutcome = (item: SecretRequestItem): Outcome | undefined => {
  // The fingerprint stays in the data: a raw hash is never UI text.
  if (item.state === "stored") return { tone: "success", text: "Secret saved" };
  if (item.state === "withdrawn") return { tone: "quiet", text: "The lead doesn't need it any more." };
  if (item.state === "open") return undefined;
  return NEWER;
};

/** What an approval approves: a gated command, a session's tool prompt, or a retro change that relaxes a playbook. */
export const approvalKind = (item: CommandApprovalItem): "command" | "permission" | "playbook" =>
  item.playbook !== undefined ? "playbook" : item.gated !== undefined ? "command" : "permission";
