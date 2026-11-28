// How Settings › Open Source Licences shows a licence text (screens/Licences.tsx).

/** A licence text with its lines rejoined into paragraphs, as a phone's width wraps them: a line break stays before a
 * blank line, an indented line and a list's item. */
export const flowed = (text: string): string => text.replace(/([^\n])\n(?![\n\s*•-]|\d+[.)] |\(\w\) )/gu, "$1 ");
