// setup_list and setup_test: the hub's setup steps for an admin, read from
// the doctor's checks.
import type { DoctorCheck, HubSetupStep } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { readHubSetup } from "../doctor/config.ts";
import { doctor } from "../doctor/index.ts";
import { githubApps } from "../github_app/index.ts";
import { test as testOnePassword } from "../onepassword/tools.ts";
import { allowsEverywhere } from "../people/tools.ts";
import { store } from "../store/hub_store.ts";
import { beforeFirstUse, guides, read as readSteps, requiredLeft } from "./index.ts";

/** The hub's own setup is an admin's: admin on every machine. */
function requireAdmin(caller: Caller): void {
  if (allowsEverywhere(caller, "admin")) return;
  throw new ToolError(
    "forbidden",
    "The hub's setup is for its owners and admins: a key with admin on every machine.",
    "Open Settings › Hub › Setup in the app, or run fleetd init on the hub.",
  );
}

/** Where devices reach the hub: its --url, else the one setup saved, else its listen address. */
export function hubUrl(hub: Hub): string {
  return hub.config.url ?? readHubSetup(hub.config.home)[0].url ?? hub.url();
}

/** The doctor's checks with the ones read from the hub's own state taken now, so a key saved a moment ago counts. */
function withFresh(hub: Hub, checks: DoctorCheck[]): DoctorCheck[] {
  const fresh = doctor(hub).setupChecks();
  return [...checks.filter((c) => !fresh.some((f) => f.id === c.id)), ...fresh];
}

function read(hub: Hub, checks: DoctorCheck[]): HubSetupStep[] {
  const code = store(hub)
    .projectsShown()
    .filter((p) => p.kind !== "assistant").length;
  return readSteps(guides(hubUrl(hub)), beforeFirstUse(checks, code));
}

export function register(tools: Registry): void {
  tools.add("setup_list", async (hub, caller) => {
    requireAdmin(caller);
    const steps = read(hub, withFresh(hub, (await doctor(hub).list(false)).checks));
    const left = steps.filter(requiredLeft);
    const next = left[0]
      ? `Required next: ${left[0].title} (setup_test step: ${left[0].id}).`
      : "Every required step is done; the rest wait until something needs them.";
    return { next, requiredLeft: left.length, steps };
  });

  tools.add("setup_test", async (hub, caller, input) => {
    requireAdmin(caller);
    // The App's Test asks GitHub, and keeps what it said for its check.
    if (input.step === "github") {
      try {
        await githubApps(hub).test();
      } catch (error) {
        console.warn("setup: the GitHub App's test didn't run:", error);
      }
    }
    // 1Password's Test lists the vaults the caller's own token reads, on a machine holding it, and keeps it as that
    // token's last Test, which hub/onepassword_vault reads with everyone else's.
    if (input.step === "onepassword") {
      try {
        await testOnePassword(hub, caller, {});
      } catch (error) {
        console.info(`setup: no 1Password token of the caller's own tested: ${(error as Error).message ?? error}`);
      }
    }
    // Machines, Claude and the Mac read every machine's checks; the rest, the hub's own.
    const results = input.step === "machines" || input.step === "claude" || input.step === "mac" ? await doctor(hub).list(true) : await doctor(hub).rerunHub();
    const step = read(hub, withFresh(hub, results.checks)).find((s) => s.id === input.step);
    if (!step) throw new ToolError("invalid", `No setup step ${input.step}.`, "setup_list lists them.");
    return { step };
  });
}
