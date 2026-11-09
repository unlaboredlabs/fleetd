// Every module that serves MCP tools: each registers its own from its tools.ts. A new module adds its line here.
import type { Registry } from "../api/registry.ts";
import { register as r0 } from "../agents/tools.ts";
import { register as r1 } from "../api/tools.ts";
import { register as r2 } from "../approvals/tools.ts";
import { register as r3 } from "../artifacts/tools.ts";
import { register as r4 } from "../automations/tools.ts";
import { register as r5 } from "../browser/tools.ts";
import { register as r6 } from "../chat/tools.ts";
import { register as r7 } from "../chat_pins/tools.ts";
import { register as r8 } from "../checklist/tools.ts";
import { register as r9 } from "../claude_accounts/tools.ts";
import { register as r10 } from "../doctor/tools.ts";
import { register as r11 } from "../executor/tools.ts";
import { register as r12 } from "../github_app/tools.ts";
import { register as r13 } from "../hub_links/tools.ts";
import { register as r14 } from "../info/tools.ts";
import { register as r15 } from "../leads/tools.ts";
import { register as r16 } from "../ledger/tools.ts";
import { register as r17 } from "../machine_roles/tools.ts";
import { register as r18 } from "../machine_setup/tools.ts";
import { register as r19 } from "../mcp_oauth/tools.ts";
import { register as r20 } from "../mcp_servers/tools.ts";
import { register as r21 } from "../memory/tools.ts";
import { register as r22 } from "../metrics/tools.ts";
import { register as r23 } from "../navi/tools.ts";
import { register as r24 } from "../onepassword/tools.ts";
import { register as r25 } from "../orders/tools.ts";
import { register as r26 } from "../pair/tools.ts";
import { register as r27 } from "../people/tools.ts";
import { register as r28 } from "../pool/tools.ts";
import { register as r29 } from "../projects/tools.ts";
import { register as r30 } from "../prompts/tools.ts";
import { register as r31 } from "../prs/tools.ts";
import { register as r32 } from "../push/tools.ts";
import { register as r33 } from "../setup/tools.ts";
import { register as r34 } from "../sidebar_order/tools.ts";
import { register as r35 } from "../skills/tools.ts";
import { register as r36 } from "../status/tools.ts";
import { register as r37 } from "../steer/tools.ts";
import { register as r38 } from "../tasks/tools.ts";
import { register as r39 } from "../time/tools.ts";
import { register as r40 } from "../train/tools.ts";
import { register as r41 } from "../update/tools.ts";
import { register as r42 } from "../usage/tools.ts";
import { register as r43 } from "../wakes/tools.ts";
import { register as r44 } from "../work/tools.ts";

/** Every module that serves MCP tools, each replacing the registry's stubs for its own. */
export function registerAll(tools: Registry): void {
  r0(tools); // hub/agents
  r1(tools); // hub/api
  r2(tools); // hub/approvals
  r3(tools); // hub/artifacts
  r4(tools); // hub/automations
  r5(tools); // hub/browser
  r6(tools); // hub/chat
  r7(tools); // hub/chat_pins
  r8(tools); // hub/checklist
  r9(tools); // hub/claude_accounts
  r10(tools); // hub/doctor
  r11(tools); // hub/executor
  r12(tools); // hub/github_app
  r13(tools); // hub/hub_links
  r14(tools); // hub/info
  r15(tools); // hub/leads
  r16(tools); // hub/ledger
  r17(tools); // hub/machine_roles
  r18(tools); // hub/machine_setup
  r19(tools); // hub/mcp_oauth
  r20(tools); // hub/mcp_servers
  r21(tools); // hub/memory
  r22(tools); // hub/metrics
  r23(tools); // hub/navi
  r24(tools); // hub/onepassword
  r25(tools); // hub/orders
  r26(tools); // hub/pair
  r27(tools); // hub/people
  r28(tools); // hub/pool
  r29(tools); // hub/projects
  r30(tools); // hub/prompts
  r31(tools); // hub/prs
  r32(tools); // hub/push
  r33(tools); // hub/setup
  r34(tools); // hub/sidebar_order
  r35(tools); // hub/skills
  r36(tools); // hub/status
  r37(tools); // hub/steer
  r38(tools); // hub/tasks
  r39(tools); // hub/time
  r40(tools); // hub/train
  r41(tools); // hub/update
  r42(tools); // hub/usage
  r43(tools); // hub/wakes
  r44(tools); // hub/work
}
