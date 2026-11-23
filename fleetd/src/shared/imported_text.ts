// A JSON file imported `with { type: "text" }` is its text under Bun, but TypeScript's own checker types any JSON
// import as the object, so it is read through here: a string checked as one, the same under both checkers.

/** The text of a file imported `with { type: "text" }`. */
export function importedText(imported: unknown): string {
  if (typeof imported !== "string") throw new TypeError("a file imported as text came as something else");
  return imported;
}
