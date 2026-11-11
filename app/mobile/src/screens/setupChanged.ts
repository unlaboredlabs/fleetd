// A lead's setup change (repo_add, repo_remove, project_setup, W614) as its line in the chat says it: what changed,
// whether a person took it back, and what VoiceOver reads for the line.
import type { ChatMessage } from "../desktop";

export interface SetupLine {
  readonly text: string;
  /** Taken back already: the line says so in place of Undo. */
  readonly undone: boolean;
  readonly label: string;
}

/** The line a message is, when it is a lead's setup change; a message of any other kind is none. */
export function setupLine(message: Pick<ChatMessage, "text" | "setupChanged"> | undefined): SetupLine | undefined {
  const changed = message?.setupChanged;
  if (message === undefined || changed === undefined) return undefined;
  const text = message.text.replace(/`/gu, "").trim();
  const undone = changed.undone === true;
  return { text, undone, label: undone ? `${text}. Undone` : text };
}
