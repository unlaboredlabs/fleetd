// The `fleetd` binary: `bun build --compile src/main.ts` (package.json `compile`), or `bun src/main.ts` from source.
import { main } from "./cli/index.ts";

process.exit(await main(process.argv.slice(2)));
