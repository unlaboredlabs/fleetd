// Writes <file>.blockmap, the map of a desktop app zip that electron-updater's differential download reads, with
// electron-builder's own builder from app/desktop's node_modules (so the chunking is the one the app expects):
//
//   node blockmap.mjs <file>
//
// The AppImage carries its map inside (electron-builder appends it); update-yml.sh only reads its size.
import { createRequire } from "node:module";

const desktop = createRequire(new URL("../../app/desktop/package.json", import.meta.url));
const builder = createRequire(desktop.resolve("electron-builder"));
const { buildBlockMap } = builder("app-builder-lib/out/targets/blockmap/blockmap.js");

const file = process.argv[2];
if (file === undefined) {
  console.error("usage: blockmap.mjs <file>");
  process.exit(2);
}
await buildBlockMap(file, "gzip", `${file}.blockmap`);
