// A chat row's bubbles, as the phone shows them: a lead message of several parts is several bubbles, and a block in
// one is said in words (an ask keeps its question and buttons; a chart, table or diff is for the desktop). Pure, so
// it is unit-tested.
import type { ChatItem } from "./desktop";

export type Bubble =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ask"; readonly question: string; readonly options: readonly string[] }
  | { readonly kind: "block"; readonly text: string };

const BLOCK_WORDS: Readonly<Record<string, string>> = {
  chart: "A chart",
  table: "A table",
  diff: "A diff",
  pr: "A pull request",
  agent: "An agent",
  checklist: "A checklist",
  image: "An image",
  clip: "A clip",
};

export const bubbles = (item: Pick<ChatItem, "text" | "message">): readonly Bubble[] => {
  const parts = item.message?.parts;
  if (parts === undefined || parts.length === 0 || item.message?.state === "streaming") return item.text.trim() === "" ? [] : [{ kind: "text", text: item.text }];
  return parts.flatMap((p): Bubble[] => {
    const block = p.block;
    if (block === undefined) {
      const text = item.text.slice(p.start, p.end).trim();
      return text === "" ? [] : [{ kind: "text", text }];
    }
    if (block.kind === "ask") return [{ kind: "ask", question: block.question, options: block.options ?? ["Approve", "Deny"] }];
    return [{ kind: "block", text: `${BLOCK_WORDS[block.kind] ?? "Something"} the desktop app shows.` }];
  });
};

/** What a row of the person's own says about where it is, or undefined once the hub has it. */
export const sendNote = (item: Pick<ChatItem, "state" | "error" | "leadWaiting">): string | undefined => {
  switch (item.state) {
    case "pending":
      return "Sending…";
    case "queued":
      return "Not connected: it goes when the hub is back.";
    case "reconnecting":
      return "The link dropped: it goes again when the hub is back.";
    case "unanswered":
      return "The hub didn't answer. Tap to send again.";
    case "failed":
      return `Not sent: ${item.error?.message ?? "the hub refused it"} Tap to send again.`;
    default:
      return item.leadWaiting;
  }
};
