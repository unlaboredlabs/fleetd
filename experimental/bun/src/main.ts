// The `fleetd` binary: `bun build --compile src/main.ts` (package.json `compile`), or `bun src/main.ts` from source.
// No top-level await, so the binary can ship as bytecode (`--bytecode`), which starts without parsing.
import { main } from "./cli/index.ts";

main(process.argv.slice(2)).then((code) => process.exit(code));
