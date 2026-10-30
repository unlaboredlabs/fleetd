// The markdown a chat bubble shows, parsed to a small tree the Markdown component draws: paragraphs (their line breaks
// kept, as a chat writes them), headings, fenced code, quotes, lists, rules and tables; in a line, `code`, **strong**,
// *emphasis*, ~~strikes~~ and links, written or bare. A link opens only on the web or in mail: any other scheme stays
// text. Anything else is text as written. Pure, so it is unit-tested.

export type Inline =
  | { readonly t: "text"; readonly text: string }
  | { readonly t: "code"; readonly text: string }
  | { readonly t: "strong" | "em" | "del"; readonly children: readonly Inline[] }
  | { readonly t: "link"; readonly url: string; readonly children: readonly Inline[] };

export type Block =
  | { readonly t: "p"; readonly inline: readonly Inline[] }
  | { readonly t: "h"; readonly level: number; readonly inline: readonly Inline[] }
  | { readonly t: "code"; readonly lang?: string; readonly text: string }
  | { readonly t: "quote"; readonly blocks: readonly Block[] }
  | { readonly t: "list"; readonly ordered: boolean; readonly start: number; readonly items: ReadonlyArray<readonly Inline[]> }
  | { readonly t: "hr" }
  | { readonly t: "table"; readonly header: ReadonlyArray<readonly Inline[]>; readonly rows: ReadonlyArray<ReadonlyArray<readonly Inline[]>> };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/u;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/u;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/u;
const NUMBERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/u;
const QUOTE = /^ {0,3}>\s?(.*)$/u;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/u;

const isBlank = (line: string): boolean => line.trim() === "";

const cells = (line: string): string[] => {
  const inner = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return inner.split(/(?<!\\)\|/u).map((c) => c.trim());
};

/** A line that starts a block of its own, so ends a paragraph. */
const startsBlock = (line: string, next: string | undefined): boolean =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  RULE.test(line) ||
  BULLET.test(line) ||
  NUMBERED.test(line) ||
  QUOTE.test(line) ||
  (line.includes("|") && next !== undefined && TABLE_RULE.test(next) && next.includes("-"));

export const parseMarkdown = (source: string): Block[] => {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) body.push(lines[i++] ?? "");
      i++;
      const lang = fence[2] ?? "";
      blocks.push(lang === "" ? { t: "code", text: body.join("\n") } : { t: "code", lang, text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ t: "h", level: (heading[1] ?? "#").length, inline: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) body.push(QUOTE.exec(lines[i++] ?? "")?.[1] ?? "");
      blocks.push({ t: "quote", blocks: parseMarkdown(body.join("\n")) });
      continue;
    }
    const next = lines[i + 1];
    if (line.includes("|") && next !== undefined && TABLE_RULE.test(next) && next.includes("-")) {
      const header = cells(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && !isBlank(lines[i] ?? "")) rows.push(cells(lines[i++] ?? "").map(parseInline));
      blocks.push({ t: "table", header, rows });
      continue;
    }
    const ordered = NUMBERED.exec(line);
    if (ordered !== null || BULLET.test(line)) {
      const pattern = ordered !== null ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const m = pattern.exec(l);
        if (m !== null) items.push((ordered !== null ? m[2] : m[1]) ?? "");
        else if (!isBlank(l) && /^\s{2,}/u.test(l) && items.length > 0) items[items.length - 1] += `\n${l.trim()}`;
        else break;
        i++;
      }
      blocks.push({ t: "list", ordered: ordered !== null, start: ordered === null ? 1 : Number(ordered[1]), items: items.map(parseInline) });
      continue;
    }
    const para: string[] = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i] ?? "") && !startsBlock(lines[i] ?? "", lines[i + 1])) para.push(lines[i++] ?? "");
    blocks.push({ t: "p", inline: parseInline(para.join("\n")) });
  }
  return blocks;
};

const SAFE_URL = /^(https?:\/\/|mailto:)/iu;
const BARE_URL = /^https?:\/\/[^\s<>]+/iu;
/** Trailing punctuation that ends a sentence, not the URL; a ")" stays when the URL opened one. */
const trimUrl = (url: string): string => {
  let u = url.replace(/[.,;:!?'"]+$/u, "");
  while (u.endsWith(")") && (u.match(/\(/gu)?.length ?? 0) < (u.match(/\)/gu)?.length ?? 0)) u = u.slice(0, -1).replace(/[.,;:!?'"]+$/u, "");
  return u;
};

const wordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

export const parseInline = (source: string): Inline[] => {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text !== "") out.push({ t: "text", text });
    text = "";
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? "";
    const rest = source.slice(i);
    if (c === "\\" && i + 1 < source.length && /[\\`*_~[\]()#>|-]/u.test(source[i + 1] ?? "")) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const ticks = /^`+/u.exec(rest)?.[0] ?? "`";
      const end = source.indexOf(ticks, i + ticks.length);
      if (end > i) {
        flush();
        out.push({ t: "code", text: source.slice(i + ticks.length, end).replace(/^ (.+) $/u, "$1") });
        i = end + ticks.length;
        continue;
      }
    }
    const pair = rest.startsWith("**") ? "**" : rest.startsWith("__") ? "__" : rest.startsWith("~~") ? "~~" : null;
    if (pair !== null && !/\s/u.test(source[i + 2] ?? " ")) {
      const end = source.indexOf(pair, i + 2);
      if (end > i + 2 && !/\s/u.test(source[end - 1] ?? " ") && (pair !== "__" || (!wordChar(source[i - 1]) && !wordChar(source[end + 2])))) {
        flush();
        out.push({ t: pair === "~~" ? "del" : "strong", children: parseInline(source.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && !/\s/u.test(source[i + 1] ?? " ") && source[i + 1] !== c && (c === "*" || !wordChar(source[i - 1]))) {
      let end = source.indexOf(c, i + 1);
      while (end > 0 && source[end + 1] === c) end = source.indexOf(c, end + 2);
      if (end > i + 1 && !/\s/u.test(source[end - 1] ?? " ") && (c === "*" || !wordChar(source[end + 1]))) {
        flush();
        out.push({ t: "em", children: parseInline(source.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const link = /^\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/u.exec(rest);
      if (link !== null) {
        const url = link[2] ?? "";
        flush();
        const children = parseInline(link[1] ?? "");
        out.push(...(SAFE_URL.test(url) ? [{ t: "link", url, children } as const] : children));
        i += link[0].length;
        continue;
      }
    }
    if (c === "<") {
      const auto = /^<(https?:\/\/[^\s>]+|mailto:[^\s>]+)>/iu.exec(rest);
      if (auto !== null) {
        flush();
        const url = auto[1] ?? "";
        out.push({ t: "link", url, children: [{ t: "text", text: url.replace(/^mailto:/iu, "") }] });
        i += auto[0].length;
        continue;
      }
    }
    if ((c === "h" || c === "H") && !wordChar(source[i - 1])) {
      const bare = BARE_URL.exec(rest);
      if (bare !== null) {
        const url = trimUrl(bare[0]);
        flush();
        out.push({ t: "link", url, children: [{ t: "text", text: url }] });
        i += url.length;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
};

/** The inline tree as plain text: a chats list's preview. */
export const plainText = (inline: readonly Inline[]): string =>
  inline.map((n) => (n.t === "text" || n.t === "code" ? n.text : plainText(n.children))).join("");

/** The words for a lead's block that didn't show (it broke a limit, or this build can't draw it): never its JSON. */
export const UNSHOWN = "Couldn't show this";

/** A fence of a lead's block: a part with a block shows it, so one that reaches markdown didn't show. */
export const isBlockFence = (b: Block): boolean => b.t === "code" && b.lang === "fleetd-block";

/**
 * How a code block draws: as code; in a lead's or agent's words (`blocks`), a fleetd-block fence as the "couldn't
 * show this" chip once the message is final, or as a quiet placeholder while the reply still streams in, since the
 * block may still be arriving and the hub decides once the message is final. A person's fence is code they wrote.
 */
export const fenceView = (b: Block, { streaming = false, blocks }: { streaming?: boolean; blocks: boolean }): "code" | "unshown" | "pending" =>
  !blocks || !isBlockFence(b) ? "code" : streaming ? "pending" : "unshown";

/** A message's markdown as one line of plain text, for a preview: "**Done**: see `x`" → "Done: see x". */
export const previewText = (source: string, fences: { streaming?: boolean; blocks: boolean }): string =>
  parseMarkdown(source)
    .map((b): string => {
      switch (b.t) {
        case "p":
        case "h":
          return plainText(b.inline);
        case "code":
          // As the bubble draws it: a block still arriving says nothing yet.
          return { code: b.text, unshown: UNSHOWN, pending: "" }[fenceView(b, fences)];
        case "quote":
          return b.blocks.map((q) => (q.t === "p" ? plainText(q.inline) : "")).join(" ");
        case "list":
          return b.items.map(plainText).join(", ");
        case "table":
          return b.header.map(plainText).join(", ");
        case "hr":
          return "";
      }
    })
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
