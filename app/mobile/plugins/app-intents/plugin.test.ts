// What the Shortcuts plugin does to the native project, with app.config.ts's plugins in its order, on the Xcode project
// a prebuild makes before them (plugins/share-extension/test/project.pbxproj): the actions' sources in the app's own
// target, none in an extension's, written beside the AppDelegate, which lists the App Shortcuts again at launch.
import { mkdtempSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigContext, ExpoConfig } from "expo/config";
import { describe, expect, it } from "vitest";
import appConfig from "../../app.config";

const require = createRequire(import.meta.url);
const xcode = require("xcode") as { project(path: string): Project };
const { SOURCES, addSources, withRefresh } = require("./index.js") as {
  SOURCES: Record<string, string>;
  addSources(project: Project, projectName: string): void;
  withRefresh(contents: string): string;
};

interface Ref {
  value: string;
  comment: string;
}
interface Project {
  parseSync(): Project;
  writeSync(): string;
  pbxNativeTargetSection(): Record<string, { name?: string; buildPhases: Ref[] } | string>;
  hash: { project: { objects: Record<string, Record<string, any>> } };
}

type Mod = (config: Record<string, unknown>) => Promise<{ modResults: unknown }>;

const prebuild = async () => {
  const base = appConfig({ projectRoot: process.cwd() } as ConfigContext);
  let config: ExpoConfig & { mods?: Record<string, Record<string, Mod>> } = { ...base, ios: { ...base.ios, bundleIdentifier: "sh.fleetd.app" } };
  for (const plugin of base.plugins ?? []) {
    if (typeof plugin === "string" && plugin.startsWith("./plugins/") && plugin !== "./plugins/android-signing") {
      config = (require(join("../..", plugin)) as (c: typeof config) => typeof config)(config);
    }
  }
  const root = mkdtempSync(join(tmpdir(), "app-intents-"));
  const modRequest = { platform: "ios", projectRoot: root, platformProjectRoot: join(root, "ios"), projectName: "fleetd", introspect: false };
  const mods = config.mods?.ios ?? {};
  const run = async (name: string, modResults: unknown) => (await mods[name]!({ ...config, modResults, modRequest: { ...modRequest, modName: name } })).modResults;
  const project = (await run("xcodeproj", xcode.project(join(__dirname, "../share-extension/test/project.pbxproj")).parseSync())) as Project;
  await run("dangerous", undefined);
  const delegate = (await run("appDelegate", { path: join(root, "AppDelegate.swift"), language: "swift", contents: TEMPLATE })) as { contents: string };
  return { project, root, delegate };
};

/** The launch of the AppDelegate Expo's template makes. */
const TEMPLATE = `  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    reactNativeFactory = factory
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }`;

/** Each target's compiled sources, by its name. */
const sourcesOf = (project: Project): Record<string, string[]> => {
  const objects = project.hash.project.objects;
  const out: Record<string, string[]> = {};
  for (const target of Object.values(project.pbxNativeTargetSection())) {
    if (typeof target !== "object") continue;
    const phase = target.buildPhases.find((p) => p.comment === "Sources")!;
    out[String(target.name).replaceAll('"', "")] = (objects.PBXSourcesBuildPhase![phase.value] as { files: Ref[] }).files.map((f) => f.comment.replace(/ in Sources$/u, ""));
  }
  return out;
};

const { project, root, delegate } = await prebuild();
const files = Object.keys(SOURCES);

describe("plugins/app-intents", () => {
  it("builds the actions and the share sheet's link into the app's own target, and no extension's", () => {
    const sources = sourcesOf(project);
    expect(sources.fleetd).toEqual(expect.arrayContaining(["AppDelegate.swift", ...files]));
    for (const ext of ["FleetdShare", "FleetdNotifications"]) expect(sources[ext]).not.toContain("Intents.swift");
    expect(sources.FleetdShare).not.toContain("Actions.swift");
  });

  it("adds nothing to a project that has them (expo prebuild without --clean)", () => {
    const before = project.writeSync();
    addSources(project, "fleetd");
    expect(project.writeSync()).toBe(before);
  });

  it("writes the sources beside the AppDelegate", () => {
    expect(readdirSync(join(root, "ios", "fleetd")).sort()).toEqual([...files].sort());
  });

  it("lists the App Shortcuts again at each launch, once, before the launch returns", () => {
    const refresh = "if #available(iOS 18.0, *) { FleetdShortcuts.updateAppShortcutParameters() }";
    expect(delegate.contents.indexOf(refresh)).toBeGreaterThan(delegate.contents.indexOf("reactNativeFactory = factory"));
    expect(delegate.contents.indexOf(refresh)).toBeLessThan(delegate.contents.indexOf("return super.application"));
    expect(withRefresh(delegate.contents)).toBe(delegate.contents);
    expect(() => withRefresh("class AppDelegate {}")).toThrow(/no `return super.application/u);
  });
});
