// Which requests only a person may answer, whatever the Navi's approval mode (purchases.ts, permissions.ts).
import type { HumanRequest } from "../../shared/contracts.ts";

/** Payment command-line tools: a `gated_run` of one of these spends money, so it is a purchase's class too. */
export const PAYMENT_CLIS = ["stripe", "shopify", "link-cli", "paypal", "braintree", "square"];

/** Whether `program` (a command's first word, a path or a name) is a payment CLI. */
export const pays = (program: string) => PAYMENT_CLIS.includes(program.split("/").at(-1) ?? program);

/**
 * Whether only a person may answer this request, whatever the approval mode: a purchase, a secure input, a spending
 * tool of an MCP server, and a command that spends. A checker or a YOLO mode must leave these to the person.
 */
export function personOnly(r: HumanRequest): boolean {
  if (r.purchase || r.secureInput) return true;
  if (r.permission?.preview?.action === "spend") return true;
  return !!r.gated && (r.gated.class === "money" || pays(r.gated.argv[0] ?? ""));
}
