import { describe, expect, it } from "vitest";
import { dropOwner } from "./ProjectsHost";

describe("who handles a drop", () => {
  it("leaves everything inside a lead chat to the chat, images and folders alike", () => {
    expect(dropOwner({ inChat: true, inField: true, hasFiles: true })).toBe("chat");
    expect(dropOwner({ inChat: true, inField: false, hasFiles: true })).toBe("chat");
    expect(dropOwner({ inChat: true, inField: false, hasFiles: false })).toBe("chat");
  });

  it("lets a text field take dropped text but not files, and Add project the rest", () => {
    expect(dropOwner({ inChat: false, inField: true, hasFiles: false })).toBe("field");
    expect(dropOwner({ inChat: false, inField: true, hasFiles: true })).toBe("projects");
    expect(dropOwner({ inChat: false, inField: false, hasFiles: true })).toBe("projects");
  });
});
