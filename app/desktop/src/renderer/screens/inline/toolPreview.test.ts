import { describe, expect, it } from "vitest";
import type { ToolPreview } from "../../../shared/contracts";
import { actionWarning, previewNeedsConfirm, previewRows, previewTitle } from "./toolPreview";

const email: ToolPreview = {
  integration: "google",
  server: "google",
  tool: "send_message",
  action: "send",
  title: "Send an email",
  account: "me@example.com",
  to: ["ana@example.com", "bo@example.com"],
  bcc: ["dee@example.com"],
  subject: "Lunch",
  body: "Tuesday?",
  input: "{}",
};

describe("an integration's approval card", () => {
  it("lists who it acts as and reaches before what it says, and only the rows it has", () => {
    expect(previewRows(email)).toEqual([
      { label: "From", values: ["me@example.com"] },
      { label: "To", values: ["ana@example.com", "bo@example.com"] },
      { label: "Bcc", values: ["dee@example.com"] },
      { label: "Subject", values: ["Lunch"] },
    ]);
  });
  it("says who a reply reaches when the tool picks them, and an event's or a page's subject is its title", () => {
    const reply: ToolPreview = { ...email, tool: "reply", to: [], bcc: [], subject: undefined, audience: "That message's sender", target: "Message 18c2" };
    expect(previewRows(reply).map((r) => r.label)).toEqual(["From", "Reaches", "On"]);
    const event: ToolPreview = { ...email, when: "10:00 → 11:00", subject: "Review" };
    expect(previewRows(event).find((r) => r.values[0] === "Review")?.label).toBe("Title");
    expect(previewRows({ ...email, integration: "notion", account: undefined, to: [], bcc: [], subject: "Trip" })).toEqual([{ label: "Title", values: ["Trip"] }]);
  });
  it("folds to its title with its recipients", () => {
    expect(previewTitle(email)).toBe("Send an email to ana@example.com and 2 more");
    expect(previewTitle({ ...email, to: ["ana@example.com"], bcc: [] })).toBe("Send an email to ana@example.com");
    expect(previewTitle({ ...email, to: [], bcc: [] })).toBe("Send an email");
  });
  it("asks once more only for a delete or a spend", () => {
    expect(previewNeedsConfirm(email)).toBe(false);
    expect(previewNeedsConfirm({ ...email, action: "delete" })).toBe(true);
    expect(previewNeedsConfirm({ ...email, action: "spend" })).toBe(true);
    expect(actionWarning("write")).toBeUndefined();
    expect(actionWarning("send")?.text).toBe("Reaches other people");
  });
});
