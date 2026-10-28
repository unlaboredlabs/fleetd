import { describe, expect, it } from "vitest";
import type { CommandApprovalItem, ToolPreview } from "../../../shared/contracts";
import { actionWarning, answeredWords, answerWords, askTitle, domainOf, foldedBody, previewNeedsConfirm, previewOutcome, previewRows, sizeText, typeText } from "./toolPreview";

const email: ToolPreview = {
  integration: "google",
  server: "google",
  tool: "send_message",
  action: "send",
  title: "Send an email",
  account: "me@example.com",
  to: ["Ana <ana@example.com>", "bo@other.org"],
  bcc: ["dee@example.com"],
  subject: "Lunch",
  body: "Tuesday?",
  input: "{}",
};

const item = (state: CommandApprovalItem["state"]): CommandApprovalItem => ({
  requestId: "Q12",
  machineId: "devbox",
  state,
  answeredAt: "2026-10-27T09:12:00.000Z",
  permission: { threadId: "t", requestId: "p", toolName: "mcp__google__send_message", summary: "", preview: email },
});

describe("an integration's approval card", () => {
  it("names the Navi and the act", () => {
    expect(askTitle(email, "Ada")).toBe("Ada wants to send an email");
    expect(answerWords("send")).toEqual({ yes: "Send it", no: "Don't send" });
    expect(answerWords("delete")).toEqual({ yes: "Delete it", no: "Don't delete" });
    expect(answerWords("share").yes).toBe("Share it");
  });
  it("keeps one warning word, for share, delete and spend; a send's rows speak for it", () => {
    expect(actionWarning("send")).toBeUndefined();
    expect(actionWarning("write")).toBeUndefined();
    expect(actionWarning("share")?.tone).toBe("warning");
    expect(actionWarning("delete")?.text).toBe("Can't be undone");
  });
  it("lists who it reaches: outside the account's domain, and Bcc hidden from the others", () => {
    expect(domainOf("Ana <ana@Example.com>")).toBe("example.com");
    expect(domainOf("nobody")).toBeUndefined();
    expect(previewRows(email)).toEqual([
      { label: "From", values: [{ text: "me@example.com" }] },
      { label: "To", values: [{ text: "Ana <ana@example.com>" }, { text: "bo@other.org", note: "outside example.com" }] },
      { label: "Bcc", values: [{ text: "dee@example.com" }], note: "hidden from the others" },
      { label: "Subject", values: [{ text: "Lunch" }] },
    ]);
  });
  it("lists attachments by name, size, type and source", () => {
    const rows = previewRows({
      ...email,
      attachments: [
        { name: "lease.pdf", bytes: 120_400, mime: "application/pdf" },
        { name: "Café ID.PNG", bytes: 800, mime: "image/png" },
        { name: "notes.bin", bytes: 4_000, mime: "application/x-thing" },
        { name: "Drive file 1AbC", from: "from Drive" },
      ],
    });
    expect(rows.find((r) => r.label === "Attached")?.values).toEqual([
      { text: "lease.pdf", note: "120 KB · PDF" },
      { text: "Café ID.PNG", note: "800 bytes · PNG image" },
      { text: "notes.bin", note: "4 KB · application/x-thing" },
      { text: "Drive file 1AbC", note: "from Drive" },
    ]);
    expect(typeText("image/svg+xml")).toBe("SVG image");
    expect(typeText("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("Word document");
    expect(sizeText(2_400_000)).toBe("2.4 MB");
    expect(sizeText(800)).toBe("800 bytes");
  });
  it("says who a reply reaches when the tool picks them, and an event's or a page's subject is its title", () => {
    const { subject: _subject, ...noSubject } = email;
    const reply: ToolPreview = { ...noSubject, tool: "reply", to: [], bcc: [], audience: "That message's sender", target: "Message 18c2" };
    expect(previewRows(reply).map((r) => r.label)).toEqual(["From", "Reaches", "On"]);
    expect(previewRows({ ...email, when: "10:00 → 11:00", subject: "Review" }).find((r) => r.values[0]?.text === "Review")?.label).toBe("Title");
  });
  it("folds a long body for Show all, and shows a short one whole", () => {
    expect(foldedBody("Tuesday?")).toBeUndefined();
    const long = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join("\n");
    expect(foldedBody(long)?.split("\n")).toHaveLength(18);
    expect(foldedBody("x".repeat(5000))?.length).toBe(1201);
  });
  it("folds, once answered, to what was decided and who answered when", () => {
    expect(previewOutcome(email, item("open"))).toBeUndefined();
    // What the person decided, never "Sent": the tool may still refuse or fail after fleetd's card.
    expect(previewOutcome(email, item("approved"))).toEqual({ tone: "quiet", text: "Approved: send an email to Ana <ana@example.com> and 2 more" });
    expect(previewOutcome(email, item("denied"))?.text).toBe("Declined: send an email to Ana <ana@example.com> and 2 more");
    expect(previewOutcome({ ...email, action: "delete", title: "Delete a calendar event", to: [], bcc: [], target: "Event e1" }, item("approved"))?.text).toBe("Approved: delete a calendar event · Event e1");
    expect(answeredWords(item("approved"))).toMatch(/^you approved at \d\d:\d\d$/u);
    expect(answeredWords(item("denied"))).toMatch(/^you said no at /u);
  });
  it("asks once more only for a delete or a spend", () => {
    expect(previewNeedsConfirm(email)).toBe(false);
    expect(previewNeedsConfirm({ ...email, action: "delete" })).toBe(true);
    expect(previewNeedsConfirm({ ...email, action: "spend" })).toBe(true);
  });
});
