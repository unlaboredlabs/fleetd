import { describe, expect, it } from "vitest";
import data from "../../../../fixtures/inline/items.json";
import type { ChatItem, CommandApprovalItem, HumanRequest, Machine, SecretRequestItem } from "../../../shared/contracts";
import { approvalOutcome, secretEnvLines, secretOutcome, secretTarget, shellLine, withRequest } from "./request";

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
    expect(secretTarget(devbox({ boxPubKey: key }), secret("Q1"))).toEqual({
      ok: true,
      machine: "devbox",
      boxPubKey: key,
      where: "as STRIPE_SECRET_KEY in /srv/storefront/.env on devbox",
    });
    expect(secretTarget(devbox({ boxPubKey: key }), secret("Q2"))).toMatchObject({ where: "to /srv/storefront/.cdn-token on devbox" });
  });

  it("says why it can't be saved now, with what to do", () => {
    const cases: Array<[Record<string, Machine>, SecretRequestItem, string]> = [
      [devbox({}), secret("Q1"), "Update fleetd on devbox"],
      [devbox({ status: "offline", boxPubKey: key }), secret("Q1"), "back online"],
      [{}, secret("Q1"), "Add that machine"],
      [devbox({ boxPubKey: key }), { ...secret("Q1"), sink: "env:devbox:relative" }, "a destination"],
    ];
    for (const [machines, item, fix] of cases) {
      const t = secretTarget(machines, item);
      expect(t.ok).toBe(false);
      if (!t.ok) expect(t.fix).toContain(fix);
    }
  });

  it("afterwards says it was saved or withdrawn, and never the value or its fingerprint", () => {
    expect(secretOutcome(secret("Q1"))).toBeUndefined();
    expect(secretOutcome(secret("Q2"))).toEqual({ tone: "success", text: "Secret saved" });
    expect(secretOutcome(secret("Q3"))?.text).toBe("The lead doesn't need it any more.");
  });
});

describe("a command approval", () => {
  it("shows the exact command, quoting only what needs it, and the secrets it gets by name", () => {
    expect(shellLine(["git", "commit", "-m", "it's done"])).toBe(`git commit -m 'it'\\''s done'`);
    const gated = (id: string) => {
      const g = approval(id).gated;
      if (g === undefined) throw new Error(`${id} runs no command`);
      return g;
    };
    expect(shellLine(gated("Q4").argv)).toBe("pnpm run migrate --env staging");
    expect(secretEnvLines(gated("Q4"))).toEqual(["`DATABASE_URL` gets the secret `staging.db_url`"]);
    expect(secretEnvLines(gated("Q5"))).toEqual([]);
  });

  it("waits for Approve / Deny, then says one result line", () => {
    expect(approvalOutcome(approval("Q4"))).toBeUndefined();
    expect(approvalOutcome(approval("Q5"))).toEqual({ tone: "success", text: "Ran · exit 0" });
    expect(approvalOutcome(approval("Q6"))).toEqual({ tone: "danger", text: "Failed · exit 1" });
    expect(approvalOutcome(approval("Q8"))?.text).toBe("Denied. Nothing ran.");
    expect(approvalOutcome(approval("Q9"))?.text).toBe("Approved. Running…");
    // Approved while the node was offline: open again; the item shows the hub's note and asks again.
    expect(approvalOutcome(approval("Q7"))).toBeUndefined();
    // A state from a newer hub never shows as a raw word.
    expect(approvalOutcome({ ...approval("Q4"), state: "queued_on_node" })?.text).toBe("Changed on the hub. Update the app to see how.");
    expect(secretOutcome({ ...secret("Q1"), state: "sealed_pending" })?.text).toBe("Changed on the hub. Update the app to see how.");
  });
});

describe("the item as the request says it is now", () => {
  const posted = (id: string): ChatItem => {
    const it = items.find((x) => x.requestId === id);
    if (it === undefined) throw new Error(`no item ${id}`);
    return it;
  };
  const request = (r: Partial<HumanRequest> & Pick<HumanRequest, "requestId" | "kind" | "state">): HumanRequest => ({
    projectRef: { machineId: "devbox", projectId: "storefront" },
    text: "",
    createdAt: "2026-10-20T10:00:00.000Z",
    ...r,
  });

  it("takes the request's state, fingerprint and run result over the item it was posted as", () => {
    const stored = withRequest(posted("Q1"), request({ requestId: "Q1", kind: "secret", state: "stored", evidence: "fingerprint 0a1b2c3d", secret: { key: "stripe.test_key", sink: "env:devbox:/srv/storefront/.env", fingerprint: "0a1b2c3d" } }));
    expect(stored).toMatchObject({ state: "stored", fingerprint: "0a1b2c3d" });
    // Evidence that only records the outcome (here a hash) never becomes the item's note.
    expect("note" in stored).toBe(false);
    const ran = withRequest(posted("Q4"), request({ requestId: "Q4", kind: "approval", state: "failed", exitCode: 2, outputTail: "boom", evidence: "exit 2 on devbox" }));
    expect(ran).toMatchObject({ state: "failed", exitCode: 2, outputTail: "boom", note: "exit 2 on devbox" });
    expect(approvalOutcome(ran as CommandApprovalItem)).toEqual({ tone: "danger", text: "Failed · exit 2" });
  });

  it("leaves the item alone without a matching request", () => {
    expect(withRequest(posted("Q4"), undefined)).toEqual(posted("Q4"));
    expect(withRequest(posted("Q4"), request({ requestId: "Q9", kind: "approval", state: "ran" }))).toEqual(posted("Q4"));
  });
});
