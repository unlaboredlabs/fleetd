// What an error may say once it leaves the window (the app log, Copy details, Copy diagnostics): its message and stack,
// with anything that looks like a secret taken out. Shared by main and the renderer, so a card's Copy details and the
// log agree. Never message bodies or pasted text: callers pass only an error's message and stack, a route, a part.

/** An error message, after scrubbing, at most this long: room for the reason, not for a payload quoted in it. */
const MESSAGE_MAX = 300;
/** Stack frames kept: the thrower and the few above it. */
const FRAMES_MAX = 12;
const REDACTED = "[redacted]";

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // A hub agent key (`fld_` and base32), whatever its letters.
  [/\bfld_[a-z2-7]{8,}/giu, REDACTED],
  // An Authorization header's value.
  [/\b(Bearer|Basic)\s+[^\s"',;]+/giu, `$1 ${REDACTED}`],
  // key=value / "key": "value" pairs whose name says secret.
  [/\b([\w-]*(?:key|token|secret|password|passwd|auth|code|cookie|session)[\w-]*)(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic)\s)[^\s"',;&)]+/giu, `$1$2${REDACTED}`],
  // A URL's userinfo, query and fragment (a pairing code or a key can ride in either).
  [/\b((?:https?|wss?|fleetd):\/\/)[^\s/@]+@/giu, `$1${REDACTED}@`],
  [/\b((?:https?|wss?|fleetd):\/\/[^\s?#"')]*)[?#][^\s"')]*/giu, `$1?${REDACTED}`],
];

/**
 * 24+ characters of a key alphabet: hub keys, JWT parts, base64 runs, hashes; redacted when it has letters and
 * digits. Without "/", so a path or a URL in a stack frame stays readable.
 */
const TOKEN = /[A-Za-z0-9_+=-]{24,}/gu;

/** `text` with token-like substrings replaced, and the home directory shown as `~`. */
export const scrub = (text: string, home?: string): string => {
  let out = home !== undefined && home.length > 1 ? text.split(home).join("~") : text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out.replace(TOKEN, (token) => (/[0-9]/u.test(token) && /[A-Za-z]/u.test(token) ? REDACTED : token));
};

/** An error's first line (scrubbed and capped) and its stack frames, without anything quoted from user content. */
export const errorText = (error: { readonly message: string; readonly stack?: string | undefined; readonly name?: string | undefined }, home?: string): string => {
  const first = scrub(`${error.name ?? "Error"}: ${error.message}`.replace(/\s+/gu, " "), home);
  const head = first.length > MESSAGE_MAX ? `${first.slice(0, MESSAGE_MAX - 1)}…` : first;
  const frames = (error.stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, FRAMES_MAX)
    .map((line) => `    ${scrub(line, home)}`);
  return [head, ...frames].join("\n");
};

/**
 * The route without anything personal: no query (a pairing link's code rides there) and no project ids, which name a
 * machine. "#/project/devbox/1f0…?message=m4" → "#/project/…".
 */
export const routeShape = (hash: string): string => {
  const path = (hash.startsWith("#") ? hash : `#${hash}`).split("?")[0] ?? "#/";
  return path.startsWith("#/project/") ? "#/project/…" : path;
};

/** Any thrown value as an error-like record (a string thrown, a rejection with an object). */
export const asError = (value: unknown): { message: string; stack?: string; name?: string } => {
  if (value instanceof Error) return { message: value.message, name: value.name, ...(value.stack === undefined ? {} : { stack: value.stack }) };
  return { message: typeof value === "string" ? value : "A value that isn't an Error was thrown", name: "Thrown" };
};
