// Where a person finds a setting, as the app they use names it: the admins' group of Settings is Hub on a self-hosted
// hub and Team on a fleetd cloud team (the apps' app/desktop/src/shared/settingsPages.ts). fleetd's own lines (a
// refusal's fix, a lead's line, a doctor's check) take the group from here, never write it: fleetd cloud runs this code
// and sets the flavour once, as it starts (`setSettingsFlavour("team")`). fleetd/test/settings_paths.test.ts holds
// every line to it.

export type SettingsFlavour = "hub" | "team";

// Pure: no environment read, so every module of the package that names a page stays pure (test/pkg/purity.test.ts).
let flavour: SettingsFlavour = "hub";

/** fleetd cloud's: every team it serves is a team. Set before it serves anyone. */
export const setSettingsFlavour = (to: SettingsFlavour): void => {
  flavour = to;
};

/** The admins' group of Settings: "Hub", or "Team" on fleetd cloud. */
export const adminGroup = (): string => (flavour === "team" ? "Team" : "Hub");

/** "Settings › Hub", then each part: `settingsPath("Machines")` is "Settings › Hub › Machines", or Team's on fleetd cloud. */
export const settingsPath = (...parts: string[]): string => ["Settings", adminGroup(), ...parts].join(" › ");
