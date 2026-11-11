// What `node_action` `screens` writes into node.json (`edited`): a kind
// of screen turned on or off. An idle screen ends after 30 minutes (the agents' Mac's after 5); an older node.json's
// idle timeout goes with the first change.
import type { ScreenSettings } from "../../shared/screens_wire.ts";

/** Why the agents' Mac refuses `settings`: it offers only its own screen. */
export function macRefuses(settings: ScreenSettings): string | undefined {
  return settings.host !== undefined && settings.host !== "mac"
    ? "the agents' Mac offers only its own screen: browsers, emulators and Linux desktops run on other machines"
    : undefined;
}

const SECTION: Record<string, string> = { browser: "browser", android: "device", ios: "ios", desktop: "desktop", mac: "mac" };

/** node.json's text with `settings` applied, pretty-printed as the Rust node writes it; throws why it can't. */
export function edited(text: string, settings: ScreenSettings): string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`node.json doesn't read as JSON: ${(e as Error).message}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("node.json isn't a JSON object");
  const root = json as Record<string, unknown>;
  const set = (name: string, key: string, value: unknown) => {
    if (root[name] === undefined || root[name] === null) root[name] = {};
    const part = root[name];
    if (typeof part !== "object" || part === null || Array.isArray(part)) throw new Error(`node.json's ${name} isn't a JSON object`);
    (part as Record<string, unknown>)[key] = value;
  };
  if (settings.host !== undefined && settings.on !== undefined) set(SECTION[settings.host] ?? settings.host, "enabled", settings.on);
  delete root.screenIdleMinutes;
  for (const kind of ["browser", "device", "desktop", "ios"]) {
    const part = root[kind];
    if (typeof part === "object" && part !== null && !Array.isArray(part)) delete (part as Record<string, unknown>).idleMinutes;
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}
