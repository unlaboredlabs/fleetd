// The pages of Settings by the names its index shows them (renderer/screens/settings/SettingsSheet.tsx takes its
// labels from here), and the admins' group by the hub's flavour. The tests' check of every "Settings › …" path a
// person reads is settingsPathCheck.ts, apart, so the app's first load carries none of it.

/** You: each person's own pages. */
export const YOU_PAGES = { general: "General", accounts: "Accounts", vault: "Vault", memory: "Memory", hubs: "Hubs & devices" } as const;

/** The admins' group: Hub on a self-hosted hub, Team on a fleetd cloud team. */
export const HUB_PAGES = { people: "People", machines: "Machines", billing: "Billing", botDefaults: "Bot defaults", setup: "Setup" } as const;

/** The rows of Accounts. */
export const ACCOUNT_ROWS = ["Claude", "GitHub", "1Password"] as const;

/** The admins' group of Settings as a hub's people see it: Hub on a self-hosted hub, Team on a fleetd cloud team. */
export const adminGroup = (cloud: boolean): string => (cloud ? "Team" : "Hub");

/** "Settings › Hub", or "Settings › Team" on a cloud team, then each part. The apps' lines take it from here (fleetd's, shared/settings_path.ts). */
export const settingsPath = (cloud: boolean, ...parts: string[]): string => ["Settings", adminGroup(cloud), ...parts].join(" › ");
