// What the share extension's plugin does to the native project, with app.config.ts's plugins in its order, on the
// Xcode project a prebuild makes before them (test/project.pbxproj): the extension's target, embedded once beside the
// notification extension, its files and the keychain group both read.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigContext, ExpoConfig } from "expo/config";
import { describe, expect, it } from "vitest";
import appConfig from "../../app.config";

const require = createRequire(import.meta.url);
const xcode = require("xcode") as { project(path: string): Project };
const plist = require("@expo/plist").default as { parse(text: string): Record<string, unknown> };
const { SOURCES, TARGET, addShareTarget, findTarget } = require("./index.js") as {
  SOURCES: string[];
  TARGET: string;
  addShareTarget(project: Project, appId: string): void;
  findTarget(project: Project): Target["pbxNativeTarget"] | undefined;
};

interface Ref {
  value: string;
  comment: string;
}
interface Target {
  uuid: string;
  pbxNativeTarget: { buildPhases: Ref[]; buildConfigurationList: string; productType: string; dependencies: Ref[] };
}
interface Project {
  parseSync(): Project;
  writeSync(): string;
  pbxNativeTargetSection(): Record<string, unknown>;
  findTargetKey(name: string): string;
  getFirstTarget(): { uuid: string; firstTarget: Target["pbxNativeTarget"] };
  hash: { project: { objects: Record<string, Record<string, any>> } };
}

type Mod = (config: Record<string, unknown>) => Promise<{ modResults: unknown }>;

const GROUP = "$(AppIdentifierPrefix)sh.fleetd.app.push";

/** app.config.ts's own plugins, in its order, on the fixture project; what each mod made, and where it wrote. */
const prebuild = async () => {
  const base = appConfig({ projectRoot: process.cwd() } as ConfigContext);
  let config: ExpoConfig & { mods?: Record<string, Record<string, Mod>> } = { ...base, ios: { ...base.ios, bundleIdentifier: "sh.fleetd.app", buildNumber: "42" } };
  for (const plugin of base.plugins ?? []) {
    if (typeof plugin === "string" && plugin.startsWith("./plugins/") && plugin !== "./plugins/android-signing") {
      config = (require(join("../..", plugin)) as (c: typeof config) => typeof config)(config);
    }
  }
  const root = mkdtempSync(join(tmpdir(), "share-extension-"));
  const modRequest = { platform: "ios", projectRoot: root, platformProjectRoot: join(root, "ios"), introspect: false };
  const mods = config.mods?.ios ?? {};
  const run = async (name: string, modResults: unknown) => (await mods[name]!({ ...config, modResults, modRequest: { ...modRequest, modName: name } })).modResults;
  const project = (await run("xcodeproj", xcode.project(join(__dirname, "test/project.pbxproj")).parseSync())) as Project;
  const entitlements = (await run("entitlements", {})) as Record<string, unknown>;
  await run("dangerous", undefined);
  return { project, entitlements, root };
};

const settingsOf = (project: Project, target: Target["pbxNativeTarget"]) => {
  const objects = project.hash.project.objects;
  const list = objects.XCConfigurationList![target.buildConfigurationList] as { buildConfigurations: Ref[] };
  return list.buildConfigurations.map((c) => objects.XCBuildConfiguration![c.value].buildSettings as Record<string, string>);
};

const { project, entitlements, root } = await prebuild();

describe("plugins/share-extension", () => {
  const share = findTarget(project)!;
  const app = project.getFirstTarget().firstTarget;
  const objects = project.hash.project.objects;

  it("adds the extension's target once, with its bundle id, sources and settings", () => {
    expect(share).not.toBeNull();
    expect(share.productType).toBe('"com.apple.product-type.app-extension"');
    const appTarget = settingsOf(project, app)[0]!;
    for (const settings of settingsOf(project, share)) {
      expect(settings).toMatchObject({
        PRODUCT_BUNDLE_IDENTIFIER: '"sh.fleetd.app.share"',
        INFOPLIST_FILE: `${TARGET}/Info.plist`,
        CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
        IPHONEOS_DEPLOYMENT_TARGET: appTarget.IPHONEOS_DEPLOYMENT_TARGET,
        GENERATE_INFOPLIST_FILE: "NO",
      });
    }
    const sources = share.buildPhases.find((p) => p.comment === "Sources")!;
    const files = (objects.PBXSourcesBuildPhase![sources.value] as { files: Ref[] }).files.map((f) => f.comment.replaceAll('"', ""));
    expect(files).toEqual(SOURCES.map((s) => `${s} in Sources`));
  });

  it("embeds both extensions in the app in one phase, after its resources and before its scripts", () => {
    const names = app.buildPhases.map((p) => p.comment);
    expect(names.filter((n) => n === "Embed Foundation Extensions")).toHaveLength(1);
    expect(names.indexOf("Embed Foundation Extensions")).toBe(names.indexOf("Resources") + 1);
    expect(names.indexOf("Embed Foundation Extensions")).toBeLessThan(names.indexOf("Bundle React Native code and images"));
    expect(names).not.toContain("Copy Files");
    const embed = app.buildPhases.find((p) => p.comment === "Embed Foundation Extensions")!;
    const phase = objects.PBXCopyFilesBuildPhase![embed.value] as { files: Ref[]; dstSubfolderSpec: number };
    expect(phase.dstSubfolderSpec).toBe(13);
    expect(phase.files.map((f) => f.comment).sort()).toEqual(["FleetdNotifications.appex in Copy Files", "FleetdShare.appex in Copy Files"]);
    expect(Object.keys(objects.PBXCopyFilesBuildPhase!).filter((k) => !k.endsWith("_comment"))).toHaveLength(1);
    // The app builds after both.
    expect(app.dependencies).toHaveLength(2);
  });

  it("adds nothing to a project that has it (expo prebuild without --clean)", () => {
    const before = project.writeSync();
    addShareTarget(project, "sh.fleetd.app");
    expect(project.writeSync()).toBe(before);
  });

  it("writes a project that reads back the same", () => {
    const file = join(root, "project.pbxproj");
    writeFileSync(file, project.writeSync());
    const again = xcode.project(file).parseSync();
    expect(findTarget(again)?.productType).toBe('"com.apple.product-type.app-extension"');
    expect(again.writeSync()).toBe(project.writeSync());
  });

  it("gives the app the keychain group the extension reads the pairing from", () => {
    expect(entitlements["keychain-access-groups"]).toEqual([GROUP]);
    const own = plist.parse(readFileSync(join(root, "ios", TARGET, `${TARGET}.entitlements`), "utf8"));
    expect(own).toEqual({ "keychain-access-groups": [GROUP] });
  });

  it("writes the sources and an Info.plist for the share sheet: text, one page, up to 20 images", () => {
    expect(readdirSync(join(root, "ios", TARGET)).sort()).toEqual([...SOURCES, "Info.plist", `${TARGET}.entitlements`].sort());
    const info = plist.parse(readFileSync(join(root, "ios", TARGET, "Info.plist"), "utf8")) as Record<string, any>;
    expect(info).toMatchObject({
      CFBundleDisplayName: "fleetd",
      CFBundleShortVersionString: "0.1.0",
      CFBundleVersion: "42",
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      NSExtension: {
        NSExtensionPointIdentifier: "com.apple.share-services",
        NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).ShareViewController",
        NSExtensionAttributes: {
          NSExtensionActivationRule: {
            NSExtensionActivationSupportsText: true,
            NSExtensionActivationSupportsWebURLWithMaxCount: 1,
            NSExtensionActivationSupportsImageWithMaxCount: 20,
          },
        },
      },
    });
  });
});
