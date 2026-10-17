// What the doctor reads from `<hub home>/setup.json`, which `fleetd init` and `fleetd machine add` write
// (apps/cli/src/setup/state.ts): the hub's address, the commit identity, and how each machine was set up. Only the
// fields the doctor needs; the file may be absent (a lab or hand-joined fleet).
import fs from "node:fs";
import path from "node:path";
import * as Schema from "effect/Schema";

const SetupView = Schema.Struct({
  /** Where devices and nodes reach the hub. */
  url: Schema.optionalKey(Schema.String),
  unitSuffix: Schema.optionalKey(Schema.String),
  gitIdentity: Schema.optionalKey(Schema.Struct({ name: Schema.String, email: Schema.String })),
  machines: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        sshHost: Schema.String,
        platform: Schema.Literals(["linux", "darwin"]),
        uid: Schema.Number,
        unitSuffix: Schema.String,
      }),
    ),
  ),
});
export type HubConfig = typeof SetupView.Type;
export type MachineSetup = NonNullable<HubConfig["machines"]>[string];

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(SetupView));

/** The setup record, or why it could not be read; an absent file is an empty one. */
export const readHubConfig = (home: string): { readonly config: HubConfig; readonly problem?: string } => {
  const file = path.join(home, "setup.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { config: {} };
  }
  try {
    return { config: decode(text) };
  } catch (error) {
    return { config: {}, problem: `${file} is not valid: ${(error instanceof Error ? error.message : String(error)).split("\n", 1)[0]}` };
  }
};

/** The command that restarts a fleetd service, named as apps/cli/src/setup/units.ts names its units. */
export const restartCommand = (role: "hub" | "node" | "t3", setup: Pick<MachineSetup, "platform" | "uid" | "unitSuffix"> | undefined) =>
  setup?.platform === "darwin"
    ? `launchctl kickstart -k gui/${setup.uid}/sh.fleetd.${role}${setup.unitSuffix}`
    : `systemctl --user restart fleetd-${role}${setup?.unitSuffix ?? ""}.service`;
