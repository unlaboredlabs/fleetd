// The one-Mac lab: a workspace whose only machine is a Mac. It runs on a Mac with Xcode and an iOS runtime: a hub and a
// node of the fleetd under test (FLEETD_BIN, a macOS build), the node a normal machine that runs agents, with the
// offline claude stand-in (factory/fakeClaude.ts). One writer, on that Mac, runs `mac sim start`, builds a small SwiftUI
// app with xcodebuild, installs it into its simulator, drives it with agent-device (opens it, taps its button, reads
// the label it changed), takes a screenshot and ends the simulator. It needs Xcode, nothing else: no second Mac, no
// claude login. The first `mac sim start` makes the node's golden simulator, so a first run takes about 15 minutes.
//
// usage, on the Mac: FLEETD_BIN=<fleetd for macOS> node tests/lab/oneMacLab.ts <run dir, new or empty>
// It stops what it started by PID, deletes the simulators it made (their own device set, under the run dir), and
// leaves the run dir with its logs, `out.txt` (what each command printed) and `shot.png` (the app, tapped).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { callToolWith, check, log, ok, sleep } from "./harness.ts";
import { MACHINE, startHub, withFactory } from "./factory/kit.ts";

const BUNDLE = "dev.fleetd.onemac";

/** A SwiftUI app of one button, as an Xcode project: `sh make.sh` writes it into the current folder. */
const MAKE_APP = String.raw`set -e
mkdir -p OneMac.xcodeproj OneMac
cat > OneMac/App.swift <<'SWIFT'
import SwiftUI

@main
struct OneMacApp: App {
  var body: some Scene { WindowGroup { Tapper() } }
}

struct Tapper: View {
  @State private var taps = 0
  var body: some View {
    VStack(spacing: 24) {
      Text("One Mac").font(.largeTitle.bold())
      Text(taps == 0 ? "Not tapped yet" : "Tapped \(taps)").accessibilityIdentifier("count")
      Button("Tap me") { taps += 1 }.buttonStyle(.borderedProminent)
    }
  }
}
SWIFT
cat > OneMac.xcodeproj/project.pbxproj <<'PBX'
// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 56;
	objects = {
		A1000000000000000000000A /* App.swift in Sources */ = {isa = PBXBuildFile; fileRef = A1000000000000000000000B /* App.swift */; };
		A1000000000000000000000B /* App.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = App.swift; sourceTree = "<group>"; };
		A1000000000000000000000C /* OneMac.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = OneMac.app; sourceTree = BUILT_PRODUCTS_DIR; };
		A1000000000000000000000D = {isa = PBXGroup; children = (A1000000000000000000000E, A1000000000000000000000F); sourceTree = "<group>"; };
		A1000000000000000000000E /* OneMac */ = {isa = PBXGroup; children = (A1000000000000000000000B); path = OneMac; sourceTree = "<group>"; };
		A1000000000000000000000F /* Products */ = {isa = PBXGroup; children = (A1000000000000000000000C); name = Products; sourceTree = "<group>"; };
		A10000000000000000000010 /* Sources */ = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (A1000000000000000000000A); runOnlyForDeploymentPostprocessing = 0; };
		A10000000000000000000011 /* Frameworks */ = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; };
		A10000000000000000000012 /* OneMac */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = A10000000000000000000013;
			buildPhases = (A10000000000000000000010, A10000000000000000000011);
			buildRules = ();
			dependencies = ();
			name = OneMac;
			productName = OneMac;
			productReference = A1000000000000000000000C;
			productType = "com.apple.product-type.application";
		};
		A10000000000000000000014 /* Project object */ = {
			isa = PBXProject;
			buildConfigurationList = A10000000000000000000015;
			compatibilityVersion = "Xcode 14.0";
			mainGroup = A1000000000000000000000D;
			productRefGroup = A1000000000000000000000F;
			projectDirPath = "";
			projectRoot = "";
			targets = (A10000000000000000000012);
		};
		A10000000000000000000016 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				SDKROOT = iphoneos;
				SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
				IPHONEOS_DEPLOYMENT_TARGET = 17.0;
				SWIFT_VERSION = 5.0;
				ONLY_ACTIVE_ARCH = YES;
				ALWAYS_SEARCH_USER_PATHS = NO;
			};
			name = Debug;
		};
		A10000000000000000000017 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				SDKROOT = iphoneos;
				SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
				PRODUCT_NAME = OneMac;
				PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE};
				GENERATE_INFOPLIST_FILE = YES;
				INFOPLIST_KEY_UILaunchScreen_Generation = YES;
				INFOPLIST_KEY_CFBundleDisplayName = "One Mac";
				MARKETING_VERSION = 1.0;
				CURRENT_PROJECT_VERSION = 1;
				TARGETED_DEVICE_FAMILY = 1;
				CODE_SIGNING_ALLOWED = NO;
				CODE_SIGN_IDENTITY = "";
			};
			name = Debug;
		};
		A10000000000000000000013 = {isa = XCConfigurationList; buildConfigurations = (A10000000000000000000017); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
		A10000000000000000000015 = {isa = XCConfigurationList; buildConfigurations = (A10000000000000000000016); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
	};
	rootObject = A10000000000000000000014;
}
PBX
`;

async function main() {
  const dir = path.resolve(process.argv[2] ?? "");
  check(process.argv[2] !== undefined && (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0), "a run dir, new or empty, as the first argument");
  check(process.platform === "darwin", "the one-Mac lab runs on a Mac");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "out.txt");
  fs.writeFileSync(path.join(dir, "make.sh"), MAKE_APP);
  /** One shell line for the agent: its output, and its exit code, go to out.txt. */
  const say = (what: string, line: string) => `lab-run: { echo '$ ${what}'; ${line}; echo "exit $?"; } >> '${out}' 2>&1`;
  const app = `"$FLEETD_MAC_DERIVED_DATA/Build/Products/Debug-iphonesimulator/OneMac.app"`;
  const lines = [
    say("which Mac", "mac run -- 'hostname -s; pwd'"),
    say("mac push", "mac push"),
    say("make the app", `sh '${path.join(dir, "make.sh")}'`),
    // The first start makes the golden simulator: it says so, and the next one, minutes on, gets it.
    `lab-run: for i in $(seq 1 60); do mac sim start >> '${out}' 2>&1 && break; sleep 30; done`,
    say(
      "xcodebuild",
      `mac run -- 'xcodebuild -project OneMac.xcodeproj -scheme OneMac -sdk iphonesimulator -destination "generic/platform=iOS Simulator" build -quiet'`,
    ),
    say("install", `mac run -- 'xcrun simctl --set "$FLEETD_MAC_SIM_SET" install "$FLEETD_MAC_SIM" ${app}'`),
    say("agent-device open", `agent-device open ${BUNDLE} --foreground`),
    say("agent-device press", `agent-device press 'label="Tap me"' --settle`),
    say("agent-device snapshot", "agent-device snapshot -i"),
    say("mac sim screenshot", `mac sim screenshot shot.png && cp shot.png '${path.join(dir, "shot.png")}'`),
    say("simulators booted", `mac run -- 'xcrun simctl --set "$FLEETD_MAC_SIM_SET" list devices booted'`),
    say("mac sim end", "mac sim end"),
  ];
  const factory = path.join(dir, "factory");
  fs.mkdirSync(factory, { recursive: true });
  const hub = await startHub(factory);
  const admin = new Client({ name: "fleetd-one-mac-lab", version: "0" });
  try {
    await withFactory(factory, async (f) => {
      // One simulator at once, set by an admin in the Mac's screens settings: the Mac this runs on may lend its own to
      // other agents meanwhile.
      const url = new URL(`${hub.url}/mcp`);
      const key = await hub.key({ name: "lab-admin", role: "admin" });
      await admin.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${key}` } } }) as Transport);
      const set = await callToolWith(() => admin)("machine_roles_set", { machineId: MACHINE, maxSims: 1 });
      check(!set.isError, `machine_roles_set maxSims: ${JSON.stringify(set.body)}`);
      const roles = await f.callTool("machine_roles");
      log(`the Mac's screens settings: ${JSON.stringify((roles.body.machines as Array<Record<string, unknown>>).find((m) => m.machineId === MACHINE)?.sims)}`);
      const ws = f.workstream("one Mac");
      const task = f.spawnWriter(ws, "build and drive the app on this Mac", lines.join("\n"));
      await f.waitTask(task.taskId as string, ["idle", "done"], 45 * 60_000);
      const said = fs.readFileSync(out, "utf8");
      log(said);
      check(said.includes("mac: on this Mac"), "mac says it runs on this Mac, the one the agent runs on");
      check(said.includes("nothing to push"), "mac push has nothing to copy");
      check(said.includes("your simulator:"), "mac sim start lent a simulator");
      check(/\$ install\n(?:.*\n)*?exit 0/u.test(said), "the app installed");
      check(said.includes("Tapped 1"), "agent-device tapped the button and read the label it changed");
      check(fs.existsSync(path.join(dir, "shot.png")), "the screenshot came back");
      check(said.includes("your simulator ended"), "mac sim end ended it");
      // The simulator it ended shuts down and goes before the node stops: none outlives the run.
      const devices = path.join(factory, "machine", ".fleetd", "node", "device", "ios", "set");
      await f.until("the ended simulator gone", 120_000, async () =>
        execFileSync("xcrun", ["simctl", "--set", devices, "list", "devices", "booted"], { encoding: "utf8" }).includes("(Booted)") ? (await sleep(1000), undefined) : true,
      );
      // Its simulator was its screen in the workspace, as an agents' Mac's is: watched live, then recorded.
      const screens = await f.callTool("browser_sessions", { projectRef: f.ref });
      const ios = ((screens.body.sessions ?? []) as Array<Record<string, unknown>>).filter((s) => s.kind === "ios");
      log(`screens: ${JSON.stringify(ios.map((s) => [s.kind, s.state, s.purpose]))}`);
      check(ios.length === 1, "the simulator showed in the workspace's Screens");
      ok("one Mac: simulator, xcodebuild, install, agent-device, screenshot, end");
    }, { hub });
  } finally {
    await admin.close().catch(() => undefined);
    await hub.stop();
  }
  // The simulators the node made live in its own device set: whatever is left there goes.
  const set = path.join(dir, "factory", "machine", ".fleetd", "node", "device", "ios", "set");
  if (fs.existsSync(set)) {
    for (const verb of [["shutdown", "all"], ["delete", "all"]]) {
      try {
        execFileSync("xcrun", ["simctl", "--set", set, ...verb], { stdio: "ignore" });
      } catch {
        // None left.
      }
    }
  }
  log("PASS");
}

main().catch((error: unknown) => {
  log(`FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
