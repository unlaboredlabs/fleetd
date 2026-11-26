// A bot's safety settings are the workspace's owners' and admins': a member sees them, with their controls off and
// one line saying so. The workspace refuses a member's change all the same.
import { botLocked } from "../../../shared/hub";
import { useHubRole } from "../admin/role";

export { BOT_ADMIN_ONLY } from "../../../shared/hub";

/** True once the workspace says this app's person is a member. */
export const useBotLocked = (): boolean => botLocked(useHubRole().me?.role);
