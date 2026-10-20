import { describe, expect, it } from "vitest";
import { dropOwner, mayBeProject } from "./ProjectsHost";

describe("who handles a drop", () => {
  it("leaves a drop the chat's composer took (its files) to the chat", () => {
    expect(dropOwner({ taken: true, inField: false, hasFiles: true })).toBe("taken");
    expect(dropOwner({ taken: true, inField: true, hasFiles: true })).toBe("taken");
  });

  it("takes a folder or link the chat passed on, so a repo folder dropped on the chat opens Add project", () => {
    // The composer leaves folders and links undefaultPrevented: inside the chat they are Add project's.
    expect(dropOwner({ taken: false, inField: false, hasFiles: true })).toBe("projects");
    expect(dropOwner({ taken: false, inField: false, hasFiles: false })).toBe("projects");
  });

  it("lets a text field take dropped text but not files", () => {
    expect(dropOwner({ taken: false, inField: true, hasFiles: false })).toBe("field");
    expect(dropOwner({ taken: false, inField: true, hasFiles: true })).toBe("projects");
  });
});

describe("what may be a project while it is dragged", () => {
  const file = (type: string) => ({ kind: "file", type });

  it("rules out a drag of only images, video, audio or PDFs, so no Add project overlay shows for them", () => {
    expect(mayBeProject(["Files"], [file("image/png")])).toBe(false);
    expect(mayBeProject(["Files"], [file("image/png"), file("application/pdf")])).toBe(false);
  });

  it("keeps folders (no MIME type), link files and links", () => {
    expect(mayBeProject(["Files"], [file("")])).toBe(true);
    expect(mayBeProject(["Files"], [file("application/x-desktop")])).toBe(true);
    expect(mayBeProject(["Files"], [file("image/png"), file("")])).toBe(true);
    expect(mayBeProject(["text/uri-list", "text/plain"], [])).toBe(true);
    expect(mayBeProject(["text/html"], [])).toBe(false);
  });
});
