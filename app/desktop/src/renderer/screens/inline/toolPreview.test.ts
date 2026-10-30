import { describe, expect, it } from "vitest";
import type { CommandApprovalItem, ToolPreview } from "../../../shared/contracts";
import { actionWarning, actionWords, answeredWords, answerWords, previewNeedsConfirm, previewOutcome } from "./toolPreview";

const send: ToolPreview = {
  server: "crm",
  tool: "send_message",
  action: "send",
  title: "Use send_message on crm",
  input: '{\n  "to": "ana@example.com"\n}',
};

const item = (state: CommandApprovalItem["state"]): CommandApprovalItem => ({
  requestId: "Q12",
  machineId: "devbox",
  state,
  answeredAt: "2026-10-27T09:12:00.000Z",
  permission: { threadId: "t", requestId: "p", toolName: "mcp__crm__send_message", summary: "", preview: send },
});

describe("an integration's approval card", () => {
  it("names the act", () => {
    expect(actionWords("send")).toBe("Sends");
    expect(answerWords("send")).toEqual({ yes: "Send it", no: "Don't send" });
    expect(answerWords("delete")).toEqual({ yes: "Delete it", no: "Don't delete" });
    expect(answerWords("share").yes).toBe("Share it");
  });
  it("keeps one warning word, for share, delete and spend", () => {
    expect(actionWarning("send")).toBeUndefined();
    expect(actionWarning("write")).toBeUndefined();
    expect(actionWarning("share")?.tone).toBe("warning");
    expect(actionWarning("delete")?.text).toBe("Can't be undone");
  });
  it("folds, once answered, to what was decided and who answered when", () => {
    expect(previewOutcome(send, item("open"))).toBeUndefined();
    // What the person decided, never "Sent": the tool may still refuse or fail after fleetd's card. By its act: a tool's
    // name is a slug, shown as code on the open card.
    expect(previewOutcome(send, item("approved"))).toEqual({ tone: "quiet", text: "Approved: a send" });
    expect(previewOutcome(send, item("denied"))?.text).toBe("Declined: a send");
    expect(previewOutcome({ ...send, action: "delete" }, item("approved"))?.text).toBe("Approved: a delete");
    expect(answeredWords(item("approved"))).toMatch(/^you approved at \d\d:\d\d$/u);
    expect(answeredWords(item("denied"))).toMatch(/^you said no at /u);
  });
  it("asks once more only for a delete or a spend", () => {
    expect(previewNeedsConfirm(send)).toBe(false);
    expect(previewNeedsConfirm({ ...send, action: "delete" })).toBe(true);
    expect(previewNeedsConfirm({ ...send, action: "spend" })).toBe(true);
  });
});
