// Who is held off a bot's safety settings in the apps: a member, and anyone until the workspace says who they are; an
// owner, an admin, or a person on a workspace from before people is not.
import { expect, it } from "vitest";
import { BOT_ADMIN_ONLY, botLocked } from "./hub";

it("holds a member off a bot's safety settings, and everyone until the workspace says who they are", () => {
  expect(botLocked("member")).toBe(true);
  expect(botLocked("owner")).toBe(false);
  expect(botLocked("admin")).toBe(false);
  // Not answered yet: off, so a member never sees the controls flash on.
  expect(botLocked(undefined)).toBe(true);
  // A workspace from before people answers with no person.
  expect(botLocked(null)).toBe(false);
  expect(BOT_ADMIN_ONLY).toBe("Only admins can change this.");
});
