// Where a person finds a setting, as the app they use names it: the admins' group of Settings is Workspace, on a
// self-hosted workspace and on a fleetd cloud one alike (the apps' app/desktop/src/shared/settingsPages.ts). fleetd's
// own lines (a refusal's fix, a lead's line, a doctor's check) take the group from here, never write it.
// fleetd/test/settings_paths.test.ts holds every line to it.

export type SettingsFlavour = "hub" | "team";

/** fleetd cloud calls it as it starts. The group was "Team" there and "Hub" here; both are now "Workspace". */
export const setSettingsFlavour = (_to: SettingsFlavour): void => {};

/** The admins' group of Settings. */
export const adminGroup = (): string => "Workspace";

/** "Settings › Workspace", then each part: `settingsPath("Machines")` is "Settings › Workspace › Machines". */
export const settingsPath = (...parts: string[]): string => ["Settings", adminGroup(), ...parts].join(" › ");
