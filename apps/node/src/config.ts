import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MachineId } from "@fleetd/contracts";
import { Schema } from "effect";

export const defaultNodeHome = () => path.join(os.homedir(), ".fleetd", "node");

/** `<node home>/node.json`. Holds no secrets: the enroll token is used once in memory and never stored. */
export const NodeConfig = Schema.Struct({
  hub: Schema.String,
  machineId: MachineId,
  name: Schema.String,
  tags: Schema.Array(Schema.String),
  t3Home: Schema.String,
  t3Url: Schema.String,
  /** argv prefix that runs T3's CLI, e.g. ["t3"] or ["node", "<t3-src>/apps/server/src/bin.ts"]. */
  t3Cmd: Schema.Array(Schema.String),
  /** True once the hub has accepted this node's key. */
  enrolled: Schema.Boolean,
});
export type NodeConfig = typeof NodeConfig.Type;

const codec = Schema.fromJsonString(NodeConfig);
const configFile = (home: string) => path.join(home, "node.json");

export const readConfig = (home: string): NodeConfig | undefined => {
  const file = configFile(home);
  return fs.existsSync(file) ? Schema.decodeUnknownSync(codec)(fs.readFileSync(file, "utf8")) : undefined;
};

export const writeConfig = (home: string, config: NodeConfig) => {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile(home), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
};
