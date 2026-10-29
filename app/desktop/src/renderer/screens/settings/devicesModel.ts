// Settings › You › Your devices: which of the hub's human keys are yours, the one a phone just paired with, how long a
// pairing code has left, and the QR of its link. The hub decides who sees which devices (people_list) and what the link
// carries (pair_code_create: a one-time code and an address a phone reaches, never loopback); these only present it.
import { encode } from "uqr";
import type { AgentKeyInfo, PeopleListOutput } from "../../../shared/contracts";

/** Your own devices, oldest first; none for a key with no person. */
export const yourDevices = (read: PeopleListOutput | undefined): AgentKeyInfo[] =>
  read?.me === undefined ? [] : read.devices.filter((d) => d.person?.personId === read.me && d.revokedAt === undefined);

/** The device that paired since the code was made, `before` being the devices there were then: the newest of them. */
export const pairedSince = (devices: ReadonlyArray<AgentKeyInfo>, before: ReadonlySet<string>): AgentKeyInfo | undefined =>
  devices.filter((d) => !before.has(d.keyId)).at(-1);

const two = (n: number): string => String(n).padStart(2, "0");

/** "Works once, for 15 more minutes (until 10:15)."; null once it has expired. */
export function codeLife(expiresAt: string, nowMs: number): string | null {
  const end = Date.parse(expiresAt);
  const left = end - nowMs;
  if (Number.isNaN(left) || left <= 0) return null;
  const minutes = Math.ceil(left / 60_000);
  const at = new Date(end);
  return `Works once, for ${String(minutes)} more ${minutes === 1 ? "minute" : "minutes"} (until ${two(at.getHours())}:${two(at.getMinutes())}).`;
}

/**
 * `text` as a QR: its side in modules, with the 4-module quiet zone a scanner needs, and its dark modules as one SVG
 * path, a module a unit. Error correction L keeps a link this long at a size a phone reads from across a desk.
 */
export function qrPath(text: string): { size: number; path: string } {
  const { size, data } = encode(text, { ecc: "L", border: 4 });
  let path = "";
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${String(x)} ${String(y)}h1v1h-1z`;
    });
  });
  return { size, path };
}

/** "Paired today 10:02 · last used yesterday 16:40". */
export const deviceLine = (d: AgentKeyInfo, when: (iso: string) => string): string =>
  d.lastUsedAt === undefined ? `Paired ${when(d.createdAt)}` : `Paired ${when(d.createdAt)} · last used ${when(d.lastUsedAt)}`;
