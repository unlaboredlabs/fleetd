// The pages of Settings by the names its index shows them (renderer/screens/settings/SettingsSheet.tsx takes its
// labels from here), and the admins' group. The tests' check of every "Settings › …" path a
// person reads is settingsPathCheck.ts, apart, so the app's first load carries none of it.

/** You: each person's own pages. */
export const YOU_PAGES = { general: "General", accounts: "Accounts", vault: "Vault", memory: "Memory", hubs: "Workspaces & devices" } as const;

/** The admins' group: Workspace, on a self-hosted hub and a fleetd cloud team alike. */
export const HUB_PAGES = { people: "People", usage: "Usage", machines: "Machines", providers: "Providers", billing: "Billing", signin: "Sign-in", audit: "Audit log", share: "Share links", botDefaults: "Bot defaults", setup: "Setup" } as const;

/** The rows of Accounts. */
export const ACCOUNT_ROWS = ["Claude", "GitHub", "1Password"] as const;

/** The admins' group of Settings as a hub's people see it: Workspace, self-hosted or on the cloud (fleetd's
 * shared/settings_path.ts says the same). `cloud` stays for the callers that once told the two apart. */
export const adminGroup = (_cloud: boolean): string => "Workspace";

/** "Settings › Workspace", then each part. The apps' lines take it from here (fleetd's, shared/settings_path.ts). */
export const settingsPath = (cloud: boolean, ...parts: string[]): string => ["Settings", adminGroup(cloud), ...parts].join(" › ");
