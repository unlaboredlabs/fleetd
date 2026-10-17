// `<hub home>/hub.json`: what the doctor holds the fleet to beyond fleetd's own records. Written by `fleetd init`;
// every key is optional and the file may be absent. It holds no secrets.
import fs from "node:fs";
import path from "node:path";
import * as Schema from "effect/Schema";

export const HubConfig = Schema.Struct({
  /** The address people and phones open the hub at, e.g. https://forge.tailnet.ts.net. */
  publicUrl: Schema.optionalKey(Schema.String),
  /** The commit identity every node's git uses (for public repos, the GitHub noreply address). */
  commitIdentity: Schema.optionalKey(Schema.Struct({ name: Schema.optionalKey(Schema.String), email: Schema.String })),
});
export type HubConfig = typeof HubConfig.Type;

export const CONFIG_FILE = "hub.json";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(HubConfig));

/** The config, or why it could not be read; an absent file is an empty config. */
export const readHubConfig = (home: string): { readonly config: HubConfig; readonly problem?: string } => {
  const file = path.join(home, CONFIG_FILE);
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
