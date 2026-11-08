// `bun run helper`: puts the session-host helper beside the Bun build, as `dist/fleetd-session-host`, where the node
// finds it (src/node/runner/helper.ts). The helper is the Rust fleetd build: FLEETD_NATIVE_BIN names it, else the
// repo's own target/release or target/debug build. It is checked to answer `session-host` before it is copied.
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HELPER, hostsSessions } from "../src/node/runner/helper.ts";

const root = join(import.meta.dir, "../../..");
const from = [process.env.FLEETD_NATIVE_BIN, join(root, "target/release/fleetd"), join(root, "target/debug/fleetd")].find((p) => p && existsSync(p));
if (!from) {
  console.error("helper: no Rust fleetd build: set FLEETD_NATIVE_BIN, or cargo build -p fleetd at the repo's root");
  process.exit(1);
}
if (!hostsSessions(from)) {
  console.error(`helper: ${from} doesn't answer \`session-host\` as the Rust fleetd does`);
  process.exit(1);
}
const dist = join(import.meta.dir, "../dist");
mkdirSync(dist, { recursive: true });
const to = join(dist, HELPER);
copyFileSync(from, to);
chmodSync(to, 0o755);
console.log(`helper: ${from} -> ${to}`);
