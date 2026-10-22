import { describe, expect, it } from "vitest";
import data from "../../../../fixtures/inline/items.json";
import type { ChatItem, CommandApprovalItem, HumanRequest, Machine, SecretRequestItem } from "../../../shared/contracts";
import { approvalKind, approvalOffline, approvalOutcome, approvalTitle, failureLine, needsConfirm, OFFLINE_LINE, secretEnvLines, secretOutcome, secretTarget, secretTitle, shellLine, withRequest } from "./request";

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
      if (!t.ok && !("offline" in t)) expect(t.fix).toContain(fix);
      else throw new Error(`expected a fix for ${item.requestId}`);
    }
  });

  it("offline, checks no machine: a launch from the disk cache holds none, and the hub may well know it", () => {
    // No machines at all, as at a cold launch from the cache: never "The hub doesn't know the machine".
    expect(secretTarget({}, secret("Q1"), false)).toEqual({ ok: false, offline: true });
    expect(secretTarget(devbox({ status: "offline", boxPubKey: key }), secret("Q1"), false)).toEqual({ ok: false, offline: true });
    expect(OFFLINE_LINE.secret).toBe("Offline: save it once the hub is back.");
    // A request that names no destination says so either way: that is the request, not the connection.
    expect(secretTarget({}, { ...secret("Q1"), sink: "env:devbox:relative" }, false)).toMatchObject({ ok: false, fix: expect.stringContaining("a destination") as unknown });
  });

  it("afterwards folds to saved or not needed, and never the value or its fingerprint", () => {
    expect(secretOutcome(secret("Q1"))).toBeUndefined();
    expect(secretOutcome(secret("Q2"))).toEqual({ tone: "success", text: "Secret saved" });
    expect(secretOutcome(secret("Q3"))?.text).toBe("Not needed any more");
    // The folded row names it in the lead's words, not by its key.
    expect(secretTitle(secret("Q2"))).toBe("The deploy token for the CDN");
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

  it("tells a command, a tool prompt and a playbook gate change apart", () => {
    expect(["Q4", "Q8", "Q10"].map((id) => approvalKind(approval(id)))).toEqual(["command", "permission", "playbook"]);
    expect(approvalOutcome(approval("Q10"))).toBeUndefined();
  });

  it("offline, an open one says why it can't be answered; an answered one says nothing more", () => {
    expect(approvalOffline("open", false)).toBe("Offline: approve once the hub is back.");
    expect(approvalOffline("open", true)).toBeUndefined();
    expect(approvalOffline("approved", false)).toBeUndefined();
  });

  it("waits for Approve / Deny, then folds to one line that says how long it ran", () => {
    expect(approvalOutcome(approval("Q4"))).toBeUndefined();
    expect(approvalOutcome(approval("Q5"))).toEqual({ tone: "success", text: "Approved, ran in 12s" });
    expect(approvalOutcome(approval("Q6"))).toEqual({ tone: "danger", text: "Approved, ran in 4s · exit 1" });
    expect(approvalOutcome(approval("Q11"))).toEqual({ tone: "danger", text: "Approved, didn't run" });
    expect(approvalOutcome(approval("Q8"))?.text).toBe("Denied, nothing ran");
    expect(approvalOutcome(approval("Q9"))?.text).toBe("Approved, running…");
    // An older hub records no finish time: no duration rather than a wrong one.
    const { finishedAt: _, ...unfinished } = approval("Q5");
    expect(approvalOutcome(unfinished)?.text).toBe("Approved and ran");
    // A signal or the timeout ended it: no exit code.
    const { exitCode: __, ...stopped } = approval("Q5");
    expect(approvalOutcome(stopped)).toEqual({ tone: "warning", text: "Approved, stopped after 12s" });
    // Approved while the node was offline: open again; the item shows the hub's note and asks again.
    expect(approvalOutcome(approval("Q7"))).toBeUndefined();
    // A state from a newer hub never shows as a raw word.
    expect(approvalOutcome({ ...approval("Q4"), state: "queued_on_node" })?.text).toBe("Changed in a newer fleetd. Update the app to see it.");
    expect(secretOutcome({ ...secret("Q1"), state: "sealed_pending" })?.text).toBe("Changed in a newer fleetd. Update the app to see it.");
  });

  it("asks once more only for a command that can't be undone", () => {
    expect(["Q4", "Q5", "Q6", "Q7", "Q8", "Q10"].filter((id) => needsConfirm(approval(id)))).toEqual(["Q4", "Q7"]);
  });

  it("folds to what it was about, as plain text", () => {
    expect(approvalTitle(approval("Q4"))).toBe("Run the database migration on the staging box: it adds the share_snapshots table");
    expect(approvalTitle(approval("Q8"))).toBe("An agent wanted to use Bash");
    expect(approvalTitle(approval("Q10"))).toBe("Features, medium-size work: reviewers 1 → 0");
  });
});

describe("a failed answer", () => {
  it("is one plain sentence by the error's code, never the hub's message", () => {
    expect(failureLine("approve", { code: "failed" }, "devbox")).toEqual({ text: "Not approved: something went wrong.", retry: true });
    expect(failureLine("save", { code: "timeout" }, "devbox")).toEqual({ text: "Not saved: no answer in time.", retry: true });
    expect(failureLine("deny", { code: "disconnected" }, "devbox")).toEqual({ text: "Not denied: you're offline.", retry: true });
    expect(failureLine("save", { code: "machine_offline" }, "devbox")).toEqual({ text: "Not saved: devbox is offline.", retry: true });
    expect(failureLine("save", { code: "invalid" }, "devbox").retry).toBe(true);
    // Trying again can't help: no Retry.
    expect(failureLine("approve", { code: "forbidden" }, "devbox")).toEqual({ text: "Not approved: this computer can't answer for devbox.", retry: false });
    expect(failureLine("approve", { code: "invalid" }, "devbox")).toEqual({ text: "Not approved: it was already answered.", retry: false });
    expect(failureLine("deny", { code: "not_found" }, "devbox").retry).toBe(false);
    // A code from a newer hub still reads as a sentence.
    expect(failureLine("approve", { code: "rate_limited" }, "devbox").text).toBe("Not approved: something went wrong.");
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
    const ran = withRequest(
      posted("Q4"),
      request({ requestId: "Q4", kind: "approval", state: "ran", exitCode: 2, outputTail: "boom", evidence: "exit 2 on devbox", answeredAt: "2026-10-20T10:00:00.000Z", finishedAt: "2026-10-20T10:01:05.000Z" }),
    );
    expect(ran).toMatchObject({ state: "ran", exitCode: 2, outputTail: "boom" });
    expect(approvalOutcome(ran as CommandApprovalItem)).toEqual({ tone: "danger", text: "Approved, ran in 1m05s · exit 2" });
    const failed = withRequest(posted("Q4"), request({ requestId: "Q4", kind: "approval", state: "failed", evidence: "not run on devbox: no workspace" }));
    expect(failed).toMatchObject({ state: "failed", note: "not run on devbox: no workspace" });
  });

  it("leaves the item alone without a matching request", () => {
    expect(withRequest(posted("Q4"), undefined)).toEqual(posted("Q4"));
    expect(withRequest(posted("Q4"), request({ requestId: "Q9", kind: "approval", state: "ran" }))).toEqual(posted("Q4"));
  });
});
