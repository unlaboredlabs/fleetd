import { describe, expect, it } from "vitest";
import data from "../../../../fixtures/inline/items.json";
import type { ChatItem, CommandApprovalItem, Machine, SecretRequestItem } from "../../../shared/contracts";
import { approvalOutcome, secretEnvLine, secretOutcome, secretTarget, shellLine } from "./request";

const items = data.items as unknown as ChatItem[];
const secret = (id: string): SecretRequestItem => {
  const it = items.find((x) => x.requestId === id);
  if (it?.kind !== "secret_request") throw new Error(`no secret ${id}`);
  return it;
};
const approval = (id: string): CommandApprovalItem => {
  const it = items.find((x) => x.requestId === id);
  if (it?.kind !== "command_approval") throw new Error(`no approval ${id}`);
  return it;
};
const key = "a".repeat(43) + "=";
const devbox = (m: Partial<Machine>): Record<string, Machine> => ({
  devbox: { machineId: "devbox", name: "devbox", status: "online", lastSeenAt: "", nodeVersion: "1", tags: [], ...m },
});

describe("a secret request", () => {
  it("says where the value lands and seals to that machine's key", () => {
    expect(secretTarget(devbox({ boxPubKey: key }), secret("R1"))).toEqual({
      ok: true,
      machine: "devbox",
      boxPubKey: key,
      where: "in /srv/storefront/.env on devbox",
    });
    expect(secretTarget(devbox({ boxPubKey: key }), secret("R2"))).toMatchObject({ where: "to /srv/storefront/.cdn-token on devbox" });
  });

  it("says why it can't be saved now, with what to do", () => {
    const cases: Array<[Record<string, Machine>, SecretRequestItem, string]> = [
      [devbox({}), secret("R1"), "Update fleetd on devbox"],
      [devbox({ status: "offline", boxPubKey: key }), secret("R1"), "back online"],
      [{}, secret("R1"), "Add that machine"],
      [devbox({ boxPubKey: key }), { ...secret("R1"), sink: "env:devbox:relative" }, "a destination"],
    ];
    for (const [machines, item, fix] of cases) {
      const t = secretTarget(machines, item);
      expect(t.ok).toBe(false);
      if (!t.ok) expect(t.fix).toContain(fix);
    }
  });

  it("afterwards says it was saved (with the node's fingerprint, as code) or withdrawn, and never the value", () => {
    expect(secretOutcome(secret("R1"))).toBeUndefined();
    expect(secretOutcome(secret("R2"))).toEqual({ tone: "success", text: "Secret saved · fingerprint `ab12cd34`" });
    expect(secretOutcome(secret("R3"))?.text).toBe("The lead doesn't need it any more.");
  });
});

describe("a command approval", () => {
  it("shows the exact command, quoting only what needs it, and the secrets it gets by name", () => {
    expect(shellLine(["git", "commit", "-m", "it's done"])).toBe(`git commit -m 'it'\\''s done'`);
    expect(shellLine(approval("R4").argv ?? [])).toBe("pnpm run migrate --env staging");
    expect(secretEnvLine(approval("R4"))).toBe("Gets the secret `DATABASE_URL`");
    expect(secretEnvLine(approval("R5"))).toBeUndefined();
  });

  it("waits for Approve / Deny, then says one result line", () => {
    expect(approvalOutcome(approval("R4"))).toBeUndefined();
    expect(approvalOutcome(approval("R5"))).toEqual({ tone: "success", text: "Ran · exit 0" });
    expect(approvalOutcome(approval("R6"))).toEqual({ tone: "danger", text: "Failed · exit 1" });
    expect(approvalOutcome(approval("R7"))?.text).toBe("Denied. Nothing ran.");
    expect(approvalOutcome(approval("R8"))?.text).toBe("Approved. Running…");
    // A state from a newer hub never shows as a raw word.
    expect(approvalOutcome({ ...approval("R4"), state: "queued_on_node" })?.text).toBe("Changed on the hub. Update the app to see how.");
    expect(secretOutcome({ ...secret("R1"), state: "sealed_pending" })?.text).toBe("Changed on the hub. Update the app to see how.");
  });
});
