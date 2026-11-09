// How a request shows: as its chat item (approvals/mod.rs `chat_item`), and, settled, as the line in its lead's wake
// (usage/wire_approvals.rs `request_outcome`, leads/events.rs `Event::Request`).
import type { Attention, ChatItem, HumanRequest } from "../../shared/contracts.ts";
import { parseSecretSink } from "./sink.ts";
import { clip, shownArgv } from "./text.ts";

/** A purchase's and a secure input's fill window (fleetd-contracts purchase.rs `FILL_WINDOW_MINUTES`). */
export const FILL_WINDOW_MINUTES = 15;

/** attention/mod.rs `request_attention`: an open request is loud; an open money or irreversible command, urgent. */
export function requestAttention(r: HumanRequest): Attention | undefined {
  if (r.state !== "open") return undefined;
  return r.gated && (r.gated.class === "money" || r.gated.class === "irreversible") ? "urgent" : "loud";
}

/** How the chat shows a request: the record's fields, in the item's terms. */
export function chatItem(r: HumanRequest): ChatItem {
  const line = (s: string, max: number) => {
    const first = clip((s.split(/\r?\n/)[0] ?? s).trim(), max);
    return first.length > 0 ? first : undefined;
  };
  const by = r.answeredBy ? clip(r.answeredBy, 120) || undefined : undefined;
  // Why it is open again, or why it ended without running.
  const note = (r.state === "open" || r.state === "failed") && r.evidence ? line(r.evidence, 300) : undefined;
  if (r.secret) {
    return strip({
      kind: "secret_request",
      requestId: r.requestId,
      name: clip(r.secret.key, 120),
      text: line(r.text, 300) ?? "a secret",
      sink: r.secret.sink,
      envName: r.secret.envName,
      secureInput: r.secureInput,
      state: r.state === "stored" ? "stored" : r.state === "withdrawn" ? "withdrawn" : "open",
      fingerprint: r.secret.fingerprint,
      note,
      answeredAt: r.answeredAt,
      by,
    });
  }
  const state = ["approved", "denied", "ran", "failed"].includes(r.state) ? r.state : "open";
  return strip({
    kind: "command_approval",
    requestId: r.requestId,
    machineId: r.projectRef.machineId,
    gated: r.gated,
    permission: r.permission,
    purchase: r.purchase,
    secureInput: r.secureInput,
    state,
    exitCode: r.exitCode,
    outputTail: r.outputTail,
    note,
    answeredAt: r.answeredAt,
    by,
    finishedAt: r.finishedAt,
  });
}

function strip<T extends Record<string, unknown>>(o: T): ChatItem {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o as unknown as ChatItem;
}

/** What a settled request was and what became of it, for its line in the lead's wake. */
export function requestOutcome(r: HumanRequest): { what: string; outcome: string } {
  const machine = r.projectRef.machineId;
  let what: string;
  if (r.secret) what = `secret ${r.secret.key}`;
  else if (r.gated) what = `your command \`${clip(shownArgv(r.gated.argv), 200)}\``;
  else if (r.permission) what = `tool prompt ${r.permission.toolName} ${clip(r.permission.summary, 120)}`;
  else if (r.purchase) what = `your purchase at ${r.purchase.shop.domain} (${r.purchase.total.amount} ${r.purchase.total.currency})`;
  else if (r.secureInput) what = `your secure input ${r.secureInput.label} on ${r.secureInput.site.domain}`;
  else what = "request";
  // A secure input's secret is its own: it fills a field, never a sink to read.
  if (r.secureInput) what = `your secure input ${r.secureInput.label} on ${r.secureInput.site.domain}`;
  const evidence = r.evidence ?? "";
  const order = r.secret ? parseSecretSink(r.secret.sink)?.order : undefined;
  const byWho = r.answeredBy ? ` by ${r.answeredBy}` : "";
  const said = evidence ? `: ${evidence}` : "";
  let outcome: string;
  if (r.state === "stored" && r.secureInput) {
    outcome = "the person entered it and fleetd filled it into that field; you never see it. Carry on with the page";
  } else if (r.state === "approved" && r.secureInput) {
    outcome = `approved: call secure_input_fill with requestId ${r.requestId} within ${FILL_WINDOW_MINUTES} minutes, on that page`;
  } else if ((r.state === "denied" || r.state === "withdrawn") && r.secureInput) {
    outcome = "not given; don't get it another way: say in the chat that you didn't";
  } else if (r.state === "approved" && r.purchase) {
    outcome =
      `approved${byWho}: call purchase_fill with requestId ${r.requestId} within ${FILL_WINDOW_MINUTES} minutes, on that ` +
      "checkout with its card fields showing, then click Pay yourself";
  } else if (r.state === "denied" && r.purchase) {
    outcome =
      `denied${byWho}${said}; don't buy it, nor another way: say in the chat that you didn't, and end the browser ` +
      "session (session_end) once you're done with it";
  } else if (r.state === "stored" && order !== undefined) {
    outcome =
      `set for ${order}'s agents on ${machine} (${evidence}): each gets it at its next turn, until the order closes; ` +
      "you never see the value";
  } else {
    outcome = {
      stored: `stored on ${machine} (${evidence}); use it from its sink, you never see the value`,
      withdrawn: "withdrawn",
      denied: `denied${byWho}${said}; don't run it, say in the chat what you do instead`,
      approved: `approved (${evidence})`,
      ran: `ran: ${evidence}`,
      failed: `did not run: ${evidence}`,
      open: `open again: ${evidence}`,
    }[r.state];
  }
  return { what, outcome };
}

/** leads/events.rs `body`: a command's output tail under its line. */
function body(text: string): string[] {
  const t = text.trim();
  if (!t) return ["  > (no final message)"];
  return t.split("\n").map((l) => `  > ${l}`.trimEnd());
}

/** The wake line `Event::Request` renders for a settled request, its output tail under it when it ran. */
export function wakeLine(r: HumanRequest): string {
  const { what, outcome } = requestOutcome(r);
  const tail = r.state === "ran" ? r.outputTail : undefined;
  const rest = tail !== undefined && tail.trim() !== "" ? body(tail) : [];
  return [`- ${r.requestId} ${what}: ${outcome}`, ...rest].join("\n");
}
