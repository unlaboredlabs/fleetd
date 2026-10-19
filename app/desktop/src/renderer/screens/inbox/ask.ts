// What a question card shows and what it sends. Labels, the option order and the answer wording come from E1's
// shared helpers (shared/contracts/asks.ts, mirroring the hub); the reply text mirrors grammar.rs, so the app, the
// CLI and the phone agree.
import { ASK_UNDO_WINDOW_MS, type Ask, type AskAnswer, type GatedRunSpec } from "../../../shared/contracts";
import { answerDisplay, choices, displayLabel, humanizeKey } from "../../../shared/contracts/asks";

/** The hub's undo window. */
export const UNDO_WINDOW_MS = ASK_UNDO_WINDOW_MS;

/** grammar.rs MAX_TEXT. */
const MAX_FREE_TEXT = 2000;

/** Option verbs in the reply grammar: `a` is `ask.options[0]`, whatever order the card lists them in. */
const LETTERS = "abcdef";

export type CardPick =
  | { readonly type: "option"; readonly key: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "skip" }
  /** approve, do and secret asks: `go` approves, `done` ticks a checklist, `no` denies or declines. */
  | { readonly type: "verb"; readonly verb: "go" | "no" | "done" };

/** Free text runs to the end of the line or the next ";" in the grammar, so both become plain separators. */
export const cleanFreeText = (text: string): string =>
  text
    .replace(/\s*[\r\n]+\s*/gu, " ")
    .replace(/;/gu, ",")
    .trim()
    .slice(0, MAX_FREE_TEXT);

/** The inbox_reply text for a pick ("3 go", "3 b", "3: words", "3 skip"), or null when the ask can't take it. */
export const replyFor = (ask: Ask, pick: CardPick): string | null => {
  const n = ask.number;
  if (n === undefined) return null;
  switch (pick.type) {
    case "verb":
      return `${n} ${pick.verb}`;
    case "skip":
      return ask.recommendation === undefined ? null : `${n} skip`;
    case "text": {
      const text = cleanFreeText(pick.text);
      return text === "" ? null : `${n}: ${text}`;
    }
    case "option": {
      if (pick.key === ask.recommendation) return `${n} go`;
      const letter = LETTERS.charAt((ask.options ?? []).findIndex((o) => o.key === pick.key));
      return letter === "" ? null : `${n} ${letter}`;
    }
  }
};

const labelOf = (ask: Ask, key: string): string => {
  const option = (ask.options ?? []).find((o) => o.key === key);
  return option === undefined ? humanizeKey(key) : displayLabel(option);
};

/** "You chose: <this>", for a pick made here before the hub's answer is back. */
export const pickLabel = (ask: Ask, pick: CardPick): string => {
  switch (pick.type) {
    case "option":
      return labelOf(ask, pick.key);
    case "text":
      return cleanFreeText(pick.text);
    case "skip":
      return skipLabel(ask, ask.recommendation);
    case "verb":
      return verbLabel(ask, pick.verb);
  }
};

const skipLabel = (ask: Ask, kept: string | undefined): string =>
  kept === undefined ? "Skipped for now" : `Skipped for now (lead keeps: ${labelOf(ask, kept)})`;

const verbLabel = (ask: Ask, verb: "go" | "no" | "done"): string => {
  if (verb === "done") return "Done";
  if (ask.kind === "approve") return verb === "go" ? "Approved" : "Denied";
  return verb === "go" ? "Go" : "Declined";
};

/** The stored answer as the human reads it; `AskAnswer::display` on the hub. */
export const answerLabel = (ask: Ask, answer: AskAnswer): string => answerDisplay(answer, ask);

/** The class in plain words, only when it raises the stakes; product calls need no tag. */
export const classTag = (ask: Ask): string | null => {
  switch (ask.class) {
    case "money":
      return "Costs money";
    case "irreversible":
      return "Can't be undone";
    case "credential":
      return "Credential";
    case "product":
      return null;
  }
};

/** One full-width choice on the card. */
export interface CardOption {
  readonly id: string;
  readonly label: string;
  /** What happens if you pick it. Absent on old asks stored before labels. */
  readonly detail?: string;
  readonly recommended: boolean;
  /** The lead's one-line reason, on the recommended option only. */
  readonly reason?: string;
  readonly pick: CardPick;
}

const option = (o: Omit<CardOption, "recommended">, recommended = false): CardOption => ({ ...o, recommended });

/**
 * Every ask kind as the same card: decide lists its options (the recommendation first), approve and do get their
 * two plain answers, and a secret can only be declined here.
 */
export const cardOptions = (ask: Ask): CardOption[] => {
  switch (ask.kind) {
    case "decide":
      return choices(ask).map((o) => {
        const recommended = o.key === ask.recommendation;
        return {
          id: o.key,
          label: displayLabel(o),
          recommended,
          pick: { type: "option", key: o.key },
          ...(o.consequence === undefined ? {} : { detail: o.consequence }),
          ...(recommended && ask.recommendationWhy !== undefined ? { reason: ask.recommendationWhy } : {}),
        };
      });
    case "approve":
      return [
        option({
          id: "go",
          label: "Approve",
          detail: ask.gated === undefined ? "The agent goes ahead." : "The command above runs now.",
          pick: { type: "verb", verb: "go" },
        }),
        option({ id: "no", label: "Deny", detail: "Nothing runs; the lead hears no.", pick: { type: "verb", verb: "no" } }),
      ];
    case "do":
      return [
        option({
          id: "done",
          label: "Done",
          detail: ask.verify === undefined ? "The lead carries on." : "The hub checks it, then the lead carries on.",
          pick: { type: "verb", verb: "done" },
        }),
        option({ id: "no", label: "Won't do it", detail: "The lead hears no and works around it.", pick: { type: "verb", verb: "no" } }),
      ];
    case "secret":
      return [
        option({ id: "no", label: "Decline", detail: "The lead hears no and works without it.", pick: { type: "verb", verb: "no" } }),
      ];
  }
};

/** "Something else…" and "Skip for now" are for product calls, and a skip needs a recommendation to keep. */
export const takesFreeText = (ask: Ask): boolean => ask.kind === "decide";
export const takesSkip = (ask: Ask): boolean => ask.kind === "decide" && ask.recommendation !== undefined;

export type CardKey = { readonly kind: "pick"; readonly n: number } | { readonly kind: "no" } | { readonly kind: "enter" };

export interface CardKeyInput {
  readonly key: string;
  readonly code: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
}

/**
 * The card's keys, the palette's picker keys (COPY of screens/palette/keymap.ts pickerKey, not on this branch yet;
 * swap to it once it is): 1–9 pick, Enter confirms, N picks the No answer. Nothing typed in a field is a shortcut
 * (`inField`: an input, textarea, select or contenteditable), nor is a key mid-IME or with a modifier; a focused
 * plain button (`onButton`) keeps Enter for itself.
 */
export const cardKey = (e: CardKeyInput, target: { readonly inField: boolean; readonly onButton: boolean }): CardKey | undefined => {
  if (target.inField || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return undefined;
  const digit = /^(?:Digit|Numpad)([1-9])$/u.exec(e.code)?.[1] ?? (/^[1-9]$/u.test(e.key) ? e.key : undefined);
  if (digit !== undefined) return { kind: "pick", n: Number(digit) };
  if (e.key.toLowerCase() === "n") return { kind: "no" };
  if (e.key === "Enter" && !target.onButton) return { kind: "enter" };
  return undefined;
};

/**
 * The secrets an approved command is started with, as the person must see them before approving: the variable and
 * the stored secret it comes from, never a value. Backticks: prose() shows them as code.
 */
export const secretEnvLines = (gated: GatedRunSpec): string[] =>
  (gated.secretEnv ?? []).map((e) => `\`${e.name}\` gets the secret \`${e.secretKey}\``);
