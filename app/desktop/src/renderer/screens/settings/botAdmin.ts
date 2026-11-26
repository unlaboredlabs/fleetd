// A bot's safety settings are the workspace's owners' and admins': a member sees them, with their controls off and
// one line saying so. The workspace refuses a member's change all the same.
import { botLocked } from "../../../shared/hub";
import { useHubRole } from "../admin/role";

export { BOT_ADMIN_ONLY } from "../../../shared/hub";

/** True for a member, and until the workspace has said who this app's person is. */
export function useBotLocked(): boolean {
  const role = useHubRole();
  const answered = !role.pending && !role.offline;
  return botLocked(role.me?.role ?? (answered ? null : undefined));
}
