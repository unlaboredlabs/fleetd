// What VoiceOver says for a bubble, and what it can do there: Messages reads a bubble as "who, the words, when", and
// lists a message's links among its actions. A bubble is one element (holding it is its menu), so its links and code
// blocks, which a finger taps inside it, are actions too. Pure, so it is unit-tested.
import { rowKeyOf, type Arrival } from "./arrivals";
import type { ChatItem } from "./desktop";
import { parseMarkdown, plainText, type Block, type Inline } from "./markdown";

/** A bubble's words as said: its markdown's text, a table row by row with each value after its column's name. */
export const spokenText = (source: string): string => parseMarkdown(source).map(spokenBlock).filter((s) => s !== "").join("\n");

const spokenBlock = (b: Block): string => {
  switch (b.t) {
    case "p":
    case "h":
      return plainText(b.inline);
    case "code":
      return b.text;
    case "quote":
      return b.blocks.map(spokenBlock).join("\n");
    case "list":
      return b.items.map(plainText).join("\n");
    case "table": {
      const names = b.header.map(plainText);
      return b.rows.map((row) => row.map((cell, i) => `${names[i] ?? ""} ${plainText(cell)}`.trim()).join(", ")).join("\n");
    }
    case "hr":
      return "";
  }
};

/** "Ada, Two emails need you., 9:41": who wrote it, the words, and when. */
export const bubbleLabel = (who: string, words: string, at: string): string => `${who}, ${words}, ${at}`;

/** What VoiceOver can do inside a bubble besides its menu: open each link, copy each code block. */
export type BubbleAction = { readonly t: "open"; readonly label: string; readonly url: string } | { readonly t: "copy"; readonly label: string; readonly text: string };

export const bubbleActions = (source: string): BubbleAction[] => {
  const urls: string[] = [];
  const codes: string[] = [];
  const inline = (xs: readonly Inline[]): void => {
    for (const x of xs) {
      if (x.t === "link") {
        if (!urls.includes(x.url)) urls.push(x.url);
      } else if (x.t !== "text" && x.t !== "code") inline(x.children);
    }
  };
  const block = (b: Block): void => {
    if (b.t === "p" || b.t === "h") inline(b.inline);
    else if (b.t === "list") b.items.forEach(inline);
    else if (b.t === "quote") b.blocks.forEach(block);
    else if (b.t === "table") [b.header, ...b.rows].forEach((row) => row.forEach(inline));
    else if (b.t === "code" && b.lang !== "fleetd-block") codes.push(b.text);
  };
  parseMarkdown(source).forEach(block);
  // Two links to one site are told apart by their path.
  const hosts = urls.map(hostOf);
  return [
    ...urls.map((url, i): BubbleAction => ({ t: "open", label: `Open ${hosts.filter((h) => h === hosts[i]).length > 1 ? shortUrl(url) : hosts[i]}`, url })),
    ...codes.map((text, i): BubbleAction => ({ t: "copy", label: codes.length > 1 ? `Copy Code ${String(i + 1)}` : "Copy Code", text })),
  ];
};

const hostOf = (url: string): string => {
  if (url.startsWith("mailto:")) return url.slice("mailto:".length);
  const m = /^[a-z][\w+.-]*:\/\/(?:www\.)?([^/?#:]+)/iu.exec(url);
  return m?.[1] ?? url;
};

const shortUrl = (url: string): string => url.replace(/^[a-z][\w+.-]*:\/\/(?:www\.)?/iu, "").replace(/\/$/u, "");

/**
 * What VoiceOver says as replies come in while you look (arrivals.ts' entering, which holds only those): each new
 * one once its words are written, "Ada: its first line". Your own sends aren't said: you just sent them. `heard` holds
 * the arrivals said already, and takes the ones said now: a streamed reply enters as it starts, and is said once
 * written.
 */
export const arrivedReplies = (heard: Set<Arrival>, entering: ReadonlyMap<string, Arrival>, items: readonly ChatItem[], title: string): string[] => {
  const said: string[] = [];
  for (const item of items) {
    const came = entering.get(rowKeyOf(item));
    if (came === undefined || heard.has(came)) continue;
    if (item.author === "human" || item.kind === "event" || item.state === "streaming") continue;
    heard.add(came);
    const first = spokenText(item.text).split("\n")[0]?.trim() ?? "";
    const words = first.length > 200 ? `${first.slice(0, 199)}…` : first;
    const who = item.author === "agent" ? (item.message?.by ?? "Agent") : title;
    said.push(words === "" ? `${who} sent a file` : `${who}: ${words}`);
  }
  return said;
};
