// `node scripts/mac-layout-check.ts <fleetd.app>`: the mac app electron-builder packed (on Linux in ci.yml's
// `desktop (mac layout)`, unsigned) holds what the app needs at runtime: every file of out/ in its asar, both darwin
// keyring modules unpacked beside it (a native module can't load from inside the asar), the update feed's
// app-update.yml, Electron's helpers, and an Info.plist with the bundle id, the fleetd:// scheme, the minimum macOS and
// the asar's integrity hash. Launching it is the macOS packaged smoke's (mac.yml). Run after `pnpm build`.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const app = process.argv[2];
if (app === undefined) throw new Error("usage: node scripts/mac-layout-check.ts <fleetd.app>");
const contents = path.join(app, "Contents");
const resources = path.join(contents, "Resources");
const problems: string[] = [];
const need = (ok: boolean, what: string): void => {
  if (!ok) problems.push(what);
};

/** The asar's file list, from its header: a pickled JSON tree after 16 bytes (its sizes). */
const asarFiles = (file: string): Set<string> => {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const json = Buffer.alloc(head.readUInt32LE(12));
  fs.readSync(fd, json, 0, json.length, 16);
  fs.closeSync(fd);
  type Node = { files?: Record<string, Node> };
  const files = new Set<string>();
  const walk = (node: Node, at: string): void => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const rel = at === "" ? name : `${at}/${name}`;
      if (child.files === undefined) files.add(rel);
      else walk(child, rel);
    }
  };
  walk(JSON.parse(json.toString("utf8")) as Node, "");
  return files;
};

const listed = (dir: string): string[] =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)).split(path.sep).join("/"));

need(fs.existsSync(path.join(contents, "MacOS/fleetd")), "no Contents/MacOS/fleetd");
for (const helper of ["fleetd Helper.app", "fleetd Helper (GPU).app", "fleetd Helper (Renderer).app", "fleetd Helper (Plugin).app"]) {
  need(fs.existsSync(path.join(contents, "Frameworks", helper)), `no ${helper}`);
}
need(fs.existsSync(path.join(resources, "app-update.yml")), "no Resources/app-update.yml (the update feed)");

const asar = path.join(resources, "app.asar");
if (fs.existsSync(asar)) {
  const files = asarFiles(asar);
  for (const file of ["package.json", ...listed(path.join(ROOT, "out"))]) need(files.has(file), `app.asar has no ${file}`);
} else {
  problems.push("no Resources/app.asar");
}
const unpacked = path.join(resources, "app.asar.unpacked/node_modules/@napi-rs");
for (const arch of ["arm64", "x64"]) {
  need(fs.existsSync(path.join(unpacked, `keyring-darwin-${arch}/keyring.darwin-${arch}.node`)), `no unpacked keyring-darwin-${arch} module`);
}

const plist = fs.readFileSync(path.join(contents, "Info.plist"), "utf8");
const value = (key: string): string | undefined => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1];
need(value("CFBundleIdentifier") === "sh.fleetd.app", `CFBundleIdentifier is ${value("CFBundleIdentifier")}, not sh.fleetd.app`);
need(value("LSMinimumSystemVersion") === "12.0", `LSMinimumSystemVersion is ${value("LSMinimumSystemVersion")}, not 12.0`);
need(/<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>fleetd<\/string>/.test(plist), "Info.plist doesn't claim fleetd:// links");
need(/<key>ElectronAsarIntegrity<\/key>\s*<dict>\s*<key>Resources\/app\.asar<\/key>/.test(plist), "Info.plist has no asar integrity hash");

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log(`${app}: the mac app's layout is complete`);
