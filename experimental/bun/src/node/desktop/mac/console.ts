// Whether the node's own GUI session is the one on the Mac's screen, unlocked (crates/fleetd/src/node/desktop/mac/
// console.rs): the only state in which macOS gives a session its screen's frames and takes its input events. A session
// switched to the background (Fast User Switching) or locked gets black frames and has its input dropped, so a Mac
// screen starts only while this holds, checked at every start.
//
// macOS says it in the IORegistry's root (`ioreg -n Root -d1 -a`, a property list): `IOConsoleUsers` lists each
// logged-in session with its uid, `kCGSSessionOnConsoleKey` while it is the one on the screen, and
// `CGSSessionScreenIsLocked` while its screen is locked.
import { spawnSync } from "node:child_process";

/** One logged-in GUI session, as the IORegistry lists it. */
export type ConsoleUser = { uid: number; name: string; onConsole: boolean; locked: boolean };

/** Where the node's own session is. */
export type Console =
  | { kind: "on_screen" }
  | { kind: "locked" }
  /** Logged in, but another session has the screen (`who`, when one does, else the login window). */
  | { kind: "background"; who?: string }
  | { kind: "not_logged_in" };

/** Why a Mac screen can't start, and what a person does about it, in plain words; undefined while it can. */
export function consoleBlocked(console: Console, user: string): string | undefined {
  switch (console.kind) {
    case "on_screen":
      return undefined;
    case "locked":
      return `the Mac's screen is locked: unlock it at the Mac as ${user}, and turn the screen lock off for ${user} (System Settings › Lock Screen › Require password: Never), since a locked screen gives black frames`;
    case "background":
      return console.who
        ? `${console.who} has the Mac's screen, and ${user}'s session runs in the background, which gets black frames and no input: switch the Mac's screen to ${user} (a Mac set aside for agents keeps ${user} on it)`
        : `the Mac shows its login window, and ${user}'s session runs in the background: log in as ${user} at the Mac`;
    case "not_logged_in":
      return `${user} isn't logged in to the Mac's screen: log in as ${user} at the Mac, and keep that session on the screen`;
  }
}

/** Where session `uid` is among `users`. */
export function state(uid: number, users: ConsoleUser[]): Console {
  const me = users.find((u) => u.uid === uid);
  if (!me) return { kind: "not_logged_in" };
  if (me.onConsole) return { kind: me.locked ? "locked" : "on_screen" };
  const who = users.find((u) => u.onConsole && u.uid !== uid)?.name;
  return { kind: "background", ...(who !== undefined ? { who } : {}) };
}

/** A property list value, as much of one as the console's state needs. */
type Value = { dict: [string, Value][] } | { array: Value[] } | { str: string } | { int: number } | { bool: boolean } | { other: true };

const get = (v: Value | undefined, key: string): Value | undefined =>
  v && "dict" in v ? v.dict.find(([k]) => k === key)?.[1] : undefined;

const unescape = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");

/** A property list's tags and texts, in order. */
function* tokens(xml: string): Generator<{ open: string } | { close: string } | { empty: string } | { text: string }> {
  const re = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[4] !== undefined) {
      if (m[4].trim()) yield { text: m[4] };
    } else if (m[1]) yield { close: m[2]! };
    else if (m[3]) yield { empty: m[2]! };
    else yield { open: m[2]! };
  }
}

type Tokens = ReturnType<typeof tokens>;

function textUntil(ts: Tokens, tag: string): string {
  let text = "";
  for (let t = ts.next(); !t.done; t = ts.next()) {
    if ("text" in t.value) text += t.value.text;
    else if ("close" in t.value && t.value.close === tag) return unescape(text);
    else throw new Error(`<${tag}> holds markup`);
  }
  throw new Error(`<${tag}> doesn't close`);
}

function valueAfter(ts: Tokens, first: { open: string } | { empty: string }): Value {
  if ("empty" in first) {
    if (first.empty === "true") return { bool: true };
    if (first.empty === "false") return { bool: false };
    if (first.empty === "dict") return { dict: [] };
    if (first.empty === "array") return { array: [] };
    return { other: true };
  }
  switch (first.open) {
    case "dict": {
      const entries: [string, Value][] = [];
      for (;;) {
        const t = ts.next();
        if (t.done) throw new Error("<dict> doesn't close");
        if ("close" in t.value && t.value.close === "dict") return { dict: entries };
        if (!("open" in t.value) || t.value.open !== "key") throw new Error("a <dict> entry without its <key>");
        const key = textUntil(ts, "key");
        const v = ts.next();
        if (v.done || !("open" in v.value || "empty" in v.value)) throw new Error(`<key>${key}</key> without its value`);
        entries.push([key, valueAfter(ts, v.value)]);
      }
    }
    case "array": {
      const items: Value[] = [];
      for (;;) {
        const t = ts.next();
        if (t.done) throw new Error("<array> doesn't close");
        if ("close" in t.value && t.value.close === "array") return { array: items };
        if (!("open" in t.value || "empty" in t.value)) throw new Error("text in an <array>");
        items.push(valueAfter(ts, t.value));
      }
    }
    case "string":
      return { str: textUntil(ts, "string") };
    case "integer": {
      const n = Number(textUntil(ts, "integer").trim());
      return Number.isInteger(n) ? { int: n } : { other: true };
    }
    default:
      textUntil(ts, first.open);
      return { other: true };
  }
}

/** The sessions in `ioreg -n Root -d1 -a`'s output; throws when it printed no property list. */
export function parse(xml: string): ConsoleUser[] {
  const ts = tokens(xml);
  let root: Value | undefined;
  for (let t = ts.next(); !t.done; t = ts.next()) {
    if ("open" in t.value && (t.value.open === "dict" || t.value.open === "array")) {
      root = valueAfter(ts, t.value);
      break;
    }
  }
  if (!root) throw new Error("ioreg printed no property list");
  // `-d1` prints the root entry itself, or an array of it.
  if ("array" in root) root = root.array[0] ?? { other: true };
  const users = get(root, "IOConsoleUsers");
  // No one logged in to a GUI session (or a Mac still at its login window after a restart).
  if (!users || !("array" in users)) return [];
  return users.array.flatMap((u) => {
    const uid = get(u, "kCGSSessionUserIDKey");
    if (!uid || !("int" in uid) || uid.int < 0) return [];
    const name = get(u, "kCGSSessionUserNameKey");
    const on = get(u, "kCGSSessionOnConsoleKey");
    const locked = get(u, "CGSSessionScreenIsLocked");
    return [
      {
        uid: uid.int,
        name: name && "str" in name ? name.str : "",
        onConsole: !!on && "bool" in on && on.bool,
        locked: !!locked && "bool" in locked && locked.bool,
      },
    ];
  });
}

/** Reads the IORegistry now (tens of milliseconds). */
export function read(): ConsoleUser[] {
  const out = spawnSync("/usr/sbin/ioreg", ["-n", "Root", "-d1", "-a"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (out.error) throw new Error(`cannot run ioreg: ${out.error.message}`);
  if (out.status !== 0) throw new Error(`ioreg failed: ${(out.stderr ?? "").trim()}`);
  return parse(out.stdout);
}
