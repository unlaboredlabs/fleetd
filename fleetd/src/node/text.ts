// Text held to a length without splitting a UTF-16 pair. Pure: the node's refusals (cmd/refusal.ts) use it too.

/** The end of `text` that fits `max` UTF-16 units (JS string length is UTF-16 already), never splitting a pair. */
export function tailUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  let at = text.length - max;
  const code = text.charCodeAt(at);
  if (code >= 0xdc00 && code <= 0xdfff) at++;
  return text.slice(at);
}

/** The start of `text` that fits `max` UTF-16 units, never splitting a pair. */
export function headUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}
