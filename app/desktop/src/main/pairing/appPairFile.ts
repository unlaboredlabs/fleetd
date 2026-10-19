import { join } from "node:path";

/**
 * `app-pair.json`, left by `fleetd init` / `fleetd pair` on the hub machine: `$XDG_CONFIG_HOME/fleetd/` (default
 * `~/.config`), on macOS `~/Library/Application Support/fleetd/`. Must match `app_pair_file` in
 * crates/fleetd/src/cli/pair.rs. FLEETD_HOME replaces the whole directory, so test runs never see the real one.
 */
export const appPairFile = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string => {
  const own = env["FLEETD_HOME"];
  if (own !== undefined && own !== "") return join(own, "app-pair.json");
  const xdg = env["XDG_CONFIG_HOME"];
  const config =
    platform === "darwin"
      ? join(home, "Library", "Application Support")
      : xdg !== undefined && xdg.startsWith("/")
        ? xdg
        : join(home, ".config");
  return join(config, "fleetd", "app-pair.json");
};
