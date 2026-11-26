// A share link's address and end as the phone words them. Pure, so it is unit-tested (preview.ts opens one).

/** A share link's address as the app opens it: its name (the host's first label) and the path on it; null for anything else. */
export function previewOf(address: string): { readonly name: string; readonly to: string } | null {
  const m = /^https?:\/\/([a-z0-9]{12})\.[^/?#\s]+(\/[^\s#]*)?$/iu.exec(address.trim());
  if (m === null) return null;
  const to = m[2] ?? "/";
  return { name: m[1]!.toLowerCase(), to: to.startsWith("/") && !to.startsWith("//") ? to : "/" };
}

/** "until 4:30 PM", or "until Tue 4:30 PM" past today. */
export function untilWords(at: string, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? `until ${time}` : `until ${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}
