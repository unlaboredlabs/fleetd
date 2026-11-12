// A doctor check's entry and fix as the checks build them (checks.ts), and the one check about a machine's Claude
// account settings, for another repository that reports it too.
import type { DoctorCheck, DoctorFix, DoctorStatus } from "../../shared/contracts.ts";
import type { RunnerInfo } from "../../shared/sessions.ts";

/** At most `max` characters, the last one an ellipsis when cut (hub/usage/time.rs `clip`). */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("")}…` : text;
}

export function manual(label: string, command?: string): DoctorFix {
  return { kind: "manual", label: clip(label, 200), ...(command === undefined ? {} : { command }) };
}

/** The fix with where its command runs: where the fix says, else where its check is. */
export function placed(fix: DoctorFix | undefined, scope: "hub" | "machine"): DoctorFix | undefined {
  if (!fix) return undefined;
  return fix.command !== undefined && fix.on === undefined ? { ...fix, on: scope } : fix;
}

export function machineEntry(machineId: string, name: string, status: DoctorStatus, message: string, fix?: DoctorFix): DoctorCheck {
  const f = placed(fix, "machine");
  return {
    id: `${machineId}/${name}`,
    scope: "machine",
    machineId,
    status,
    message: clip(message, 500),
    ...(f ? { fix: f } : {}),
  };
}

export const settingsFile = (info: RunnerInfo) => (info.configDir === undefined ? "~/.claude/settings.json" : `${info.configDir}/settings.json`);


/** `claude_account_override`: the machine's claude user settings set a credential or gateway in their `env`. */
export function claudeAccountOverride(machineId: string, info: RunnerInfo, configured: boolean): DoctorCheck | undefined {
  const names = configured ? info.accountOverrides : undefined;
  if (!names) return undefined;
  const settings = settingsFile(info);
  if (names.length === 0) {
    return machineEntry(
      machineId,
      "claude_account_override",
      "ok",
      `${machineId}'s claude settings set no credential of their own: its sessions run on the account fleetd gives them.`,
    );
  }
  const list = names.join(", ");
  return machineEntry(
    machineId,
    "claude_account_override",
    "warn",
    `${settings} on ${machineId} sets ${list} in its "env", which claude applies over the Claude account fleetd gives each session there.`,
    manual(
      `On ${machineId}, move ${list} out of the "env" of ${settings} (into ~/.fleetd/claude.env for the machine's own login), then restart its node`,
    ),
  );
}
