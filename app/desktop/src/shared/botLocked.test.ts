// Who is held off a bot's safety settings in the apps: a member; an owner, an admin, or no role known (a workspace
// from before people) is not.
import { expect, it } from "vitest";
import { BOT_ADMIN_ONLY, botLocked } from "./hub";

it("holds a member off a bot's safety settings, no one else", () => {
  expect(botLocked("member")).toBe(true);
  expect(botLocked("owner")).toBe(false);
  expect(botLocked("admin")).toBe(false);
  expect(botLocked(undefined)).toBe(false);
  expect(BOT_ADMIN_ONLY).toBe("Only admins can change this.");
});
