// The session and run ids the hub names: random, or derived from a request so a retry names the same one.

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function uuidOf(b: Uint8Array): string {
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** A random v4-shaped UUID. */
export const newUuid = () => uuidOf(crypto.getRandomValues(new Uint8Array(16)));

/** A v4-shaped UUID derived from `seed`: the same request always names the same session or run. */
export const uuidFrom = (seed: string) => uuidOf(new Bun.CryptoHasher("sha256").update(seed).digest().subarray(0, 16));
