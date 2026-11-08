// What `node_action` `screens` writes into node.json (crates/fleetd/src/node/screens.rs `mac_refuses`, `edited`): a kind
// of screen turned on or off, and the idle timeout of every kind.
import type { ScreenSettings } from "../../shared/screens_wire.ts";

/** Why the agents' Mac refuses `settings`: it offers only its own screen, which ends after 5 idle minutes. */
export function macRefuses(settings: ScreenSettings): string | undefined {
  if (settings.host !== undefined && settings.host !== "mac") {
    return "the agents' Mac offers only its own screen: browsers, emulators and Linux desktops run on other machines";
  }
  return settings.idleMinutes !== undefined
    ? "the agents' Mac's screen ends after 5 idle minutes, so the next agent gets it"
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
  if (settings.idleMinutes !== undefined) {
    root.screenIdleMinutes = settings.idleMinutes;
    for (const kind of ["browser", "device", "desktop", "ios"]) {
      const part = root[kind];
      if (typeof part === "object" && part !== null && !Array.isArray(part)) delete (part as Record<string, unknown>).idleMinutes;
    }
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}
