// What a chat's avatar shows for its name, on the desktop and the phone alike (app/mobile/src/avatar.ts): up to two
// initials, and which of the tints it wears, the same for the same name on every launch. Pure, so it is unit-tested.

/** "Ada" → "A", "billing-api" → "BA", "docs site" → "DS"; a name with no letters or digits keeps its first character. */
export const initials = (name: string): string => {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");
  if (words.length === 0) return Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  const first = (w: string): string => Array.from(w)[0] ?? "";
  return (words.length === 1 ? first(words[0] ?? "") : first(words[0] ?? "") + first(words[1] ?? "")).toUpperCase();
};

/** A tint index in [0, count): FNV-1a of the name, so it doesn't change between builds. */
export const tintIndex = (name: string, count: number): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return count <= 0 ? 0 : h % count;
};
