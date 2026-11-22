// A message's words while the markdown parser is still on its way (the web's first chat, on a slow link): no heading,
// quote or emphasis marks, links as their words, code as itself, a lead's block fence left out (its JSON is never
// words). Line breaks stay. A message reads the same once the parser has come; only its formatting changes.

const inline = (line: string): string =>
  line
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?)/u, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/gu, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?![\w*])/gu, "$1$2");

export function plainWords(markdown: string, blocks = true): string {
  let fence: { readonly block: boolean } | null = null;
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const open = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)/u.exec(line);
    if (open !== null) {
      fence = fence === null ? { block: blocks && open[2] === "fleetd-block" } : null;
      continue;
    }
    if (fence?.block === true) continue;
    out.push(fence === null ? inline(line) : line);
  }
  return out.join("\n").trim();
}
