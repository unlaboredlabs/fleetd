import type { Ask, Batch, GatedRunSpec, InboxReplyOutput, Machine, UsageStatus } from "@fleetd/contracts";

// What the inbox shows and sends, kept free of the DOM so it can be tested. Types only from @fleetd/contracts:
// importing its values would pull effect's Schema into the bundle.

export interface InboxItem {
  readonly batchId: string;
  readonly number: number;
  readonly ask: Ask;
}

/** Open asks still in an open batch: batches in the hub's order (newest first), then by item number. */
export const inboxItems = (batches: ReadonlyArray<Batch>, asks: ReadonlyArray<Ask>): Array<InboxItem> => {
  const byId = new Map(asks.map((ask) => [ask.askId as string, ask]));
  const items: Array<InboxItem> = [];
  for (const batch of batches) {
    if (batch.state !== "open") continue;
    for (const item of batch.items.toSorted((a, b) => a.number - b.number)) {
      const ask = byId.get(item.askId);
      if (ask?.state === "open" && ask.batchId === batch.batchId) items.push({ batchId: batch.batchId, number: item.number, ask });
    }
  }
  return items;
};

/** One tap: `raw` goes to inbox_reply with the item's batch. */
export interface Tap {
  readonly label: string;
  readonly raw: string;
  readonly tone: "go" | "no" | "plain";
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The one-tap answers for an item, in the reply grammar: "n go" takes the recommendation (or approves a stored
 * command), "n a".."n f" an option, "n done" ticks a checklist, "n no" refuses. A secret is entered, not tapped;
 * its only tap declines it.
 */
export const tapsFor = (ask: Ask, number: number): Array<Tap> => {
  const no: Tap = { label: "No", raw: `${number} no`, tone: "no" };
  switch (ask.kind) {
    case "do":
      return [{ label: "✓ Done", raw: `${number} done`, tone: "go" }, no];
    case "approve":
      return [
        { label: "Approve", raw: `${number} go`, tone: "go" },
        { label: "Reject", raw: `${number} no`, tone: "no" },
      ];
    case "secret":
      return [{ label: "Decline", raw: `${number} no`, tone: "no" }];
    case "decide": {
      const taps: Array<Tap> = [];
      if (ask.recommendation !== undefined) taps.push({ label: `Go: ${clip(ask.recommendation, 40)}`, raw: `${number} go`, tone: "go" });
      (ask.options ?? []).slice(0, 6).forEach((option, i) => {
        const letter = "abcdef"[i]!;
        taps.push({ label: `${letter}: ${clip(option, 40)}`, raw: `${number} ${letter}`, tone: "plain" });
      });
      taps.push(no);
      return taps;
    }
  }
};

/** The exact stored command, as the human approves it. `argv` is JSON so spaces and quotes stay visible. */
export const approvalRows = (gated: GatedRunSpec): Array<readonly [string, string]> => {
  const rows: Array<readonly [string, string]> = [
    ["argv", JSON.stringify(gated.argv)],
    ["cwd", gated.cwd ?? "the project workspace"],
    ["class", gated.class],
    ["reason", gated.reason],
    ["timeout", `${Math.ceil(gated.timeoutSec / 60)} min`],
  ];
  if (gated.secretEnv !== undefined && gated.secretEnv.length > 0) {
    rows.push(["secret env", gated.secretEnv.map((entry) => `${entry.name} ← ${entry.secretKey}`).join(", ")]);
  }
  return rows;
};

export interface Echo {
  readonly text: string;
  readonly ok: boolean;
}

export const replyEcho = (output: typeof InboxReplyOutput.Type): Echo =>
  output.parsed
    ? { text: output.echo ?? "Done.", ok: true }
    : { text: output.hint ?? "The hub couldn't read that reply.", ok: false };

export type SecretTarget =
  | { readonly ok: true; readonly machineId: string; readonly boxPubKey: string }
  | { readonly ok: false; readonly reason: string };

/** The machine a secret ask's sink is on, and its box key; or why it can't take the secret now. */
export const secretTarget = (ask: Ask, machines: ReadonlyArray<Machine>): SecretTarget => {
  const machineId = /^(?:env|file):([a-z0-9-]{1,32}):\//u.exec(ask.sink ?? "")?.[1];
  if (machineId === undefined) return { ok: false, reason: "This ask has no valid sink." };
  const machine = machines.find((m) => m.machineId === machineId);
  if (machine === undefined) return { ok: false, reason: `The hub doesn't know machine ${machineId}.` };
  if (machine.boxPubKey === undefined) return { ok: false, reason: `${machineId} takes no secrets: its node has no box key yet.` };
  if (machine.status === "offline") return { ok: false, reason: `${machineId} is offline. Try again when it is online.` };
  return { ok: true, machineId, boxPubKey: machine.boxPubKey };
};

export type Conn = "connecting" | "live" | "offline";

/** "2/3 machines online · 4 open asks · usage ok". Usage is left out until usage_status has answered. */
export const statusLine = (
  conn: Conn,
  machines: ReadonlyArray<Machine>,
  openAsks: number,
  usage: ReadonlyArray<UsageStatus> | undefined,
): string => {
  if (conn === "connecting") return "Connecting…";
  const parts = [
    conn === "offline" ? "offline, reconnecting" : `${machines.filter((m) => m.status === "online").length}/${machines.length} machines online`,
    openAsks === 1 ? "1 open ask" : `${openAsks} open asks`,
  ];
  if (usage !== undefined) {
    const paused = usage.filter((u) => u.breaker.state === "open").map((u) => u.machineId);
    parts.push(paused.length === 0 ? "usage ok" : `usage paused on ${paused.join(", ")}`);
  }
  return parts.join(" · ");
};

/** Hub events after which the open asks are fetched again. */
export const refreshesAsks = (type: string): boolean =>
  type.startsWith("ask.") || type === "batch.ready" || type === "decision.recorded" || type === "gated.ran";

/** The token from a pairing link (`…/#pair=<token>`), a pasted link, or a bare token. */
export const pairingToken = (text: string): string | undefined => {
  const trimmed = text.trim();
  const fromHash = /#pair=([^&\s]+)/u.exec(trimmed)?.[1];
  const token = fromHash === undefined ? trimmed : decodeURIComponent(fromHash);
  return token !== "" && token.length <= 200 && !/[\s#/]/u.test(token) ? token : undefined;
};
