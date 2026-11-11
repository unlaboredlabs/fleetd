// Every module's background loops, each started from its loops.ts. A new module adds its line here.
import type { Hub } from "../api/hub.ts";
import { start as s0 } from "../automations/loops.ts";
import { start as s1 } from "../browser/loops.ts";
import { start as s2 } from "../chat/loops.ts";
import { start as s4 } from "../github_app/loops.ts";
import { start as s5 } from "../hub_links/loops.ts";
import { start as s6 } from "../intake/loops.ts";
import { start as s7 } from "../leads/loops.ts";
import { start as s8 } from "../link/loops.ts";
import { start as s9 } from "../machine_roles/loops.ts";
import { start as s10 } from "../mcp_oauth/loops.ts";
import { start as s11 } from "../mcp_servers/loops.ts";
import { start as s12 } from "../memory/loops.ts";
import { start as s13 } from "../metrics/loops.ts";
import { start as s14 } from "../navi/loops.ts";
import { start as s15 } from "../outage/loops.ts";
import { start as s16 } from "../pair/loops.ts";
import { start as s18 } from "../projects/loops.ts";
import { start as s19 } from "../push/loops.ts";
import { start as s20 } from "../queue/loops.ts";
import { start as s21 } from "../reviews/loops.ts";
import { start as s22 } from "../slots/loops.ts";
import { start as s23 } from "../status/loops.ts";
import { start as s24 } from "../steer/loops.ts";
import { start as s25 } from "../sweep/loops.ts";
import { start as s26 } from "../tasks/loops.ts";
import { start as s27 } from "../time/loops.ts";
import { start as s28 } from "../train/loops.ts";
import { start as s29 } from "../update/loops.ts";
import { start as s30 } from "../usage/loops.ts";
import { start as s31 } from "../watchdog/loops.ts";
import { start as s32 } from "../work/loops.ts";

/** Every module's background loops ; each stops on `hub.shutdown`. */
export function startAll(hub: Hub): void {
  s0(hub); // hub/automations
  s1(hub); // hub/browser
  s2(hub); // hub/chat
  s4(hub); // hub/github_app
  s5(hub); // hub/hub_links
  s6(hub); // hub/intake
  s7(hub); // hub/leads
  s8(hub); // hub/link
  s9(hub); // hub/machine_roles
  s10(hub); // hub/mcp_oauth
  s11(hub); // hub/mcp_servers
  s12(hub); // hub/memory
  s13(hub); // hub/metrics
  s14(hub); // hub/navi
  s15(hub); // hub/outage
  s16(hub); // hub/pair
  s18(hub); // hub/projects
  s19(hub); // hub/push
  s20(hub); // hub/queue
  s21(hub); // hub/reviews
  s22(hub); // hub/slots
  s23(hub); // hub/status
  s24(hub); // hub/steer
  s25(hub); // hub/sweep
  s26(hub); // hub/tasks
  s27(hub); // hub/time
  s28(hub); // hub/train
  s29(hub); // hub/update
  s30(hub); // hub/usage
  s31(hub); // hub/watchdog
  s32(hub); // hub/work
}
