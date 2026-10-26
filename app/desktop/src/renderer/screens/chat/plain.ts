// A message's markdown as the words it shows, for a bubble's Copy text: no heading, quote or emphasis marks, links as
// their words, code as itself. Lists, line breaks and a fence's contents stay as written.

const inline = (line: string): string =>
  line
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?![\w*])/g, "$1$2");

export function plainText(markdown: string): string {
  let fenced = false;
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    out.push(fenced ? line : inline(line));
  }
  return out.join("\n").trim();
}
