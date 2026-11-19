// Settings › Claude on the phone (admins only), as the desktop's Settings › Hub › Setup › Claude has it: the hub's API
// key, sealed here to each machine's box key before it leaves the phone (as the desktop seals it on its own device),
// and its endpoint, Anthropic's own prefilled; one on the tailnet says so while Tailscale isn't connected, with Connect.
// In words the screen shows; pure, so it is tested on its own (the random one-time key comes from the screen).
import type { ClaudeHubApi, Machine } from "../../desktop/src/shared/contracts";
import { fromBase64, toBase64, utf8Encode } from "./bytes";
import { keyPairOf, seal } from "./seal";

export { ANTHROPIC_ENDPOINT, endpointShown, endpointToSave, tailnetLine } from "../../desktop/src/shared/claudeEndpoint";

/** The Settings row shows for an admin. */
export const claudeShown = (admin: boolean | undefined): boolean => admin === true;

/** Every machine a Claude secret is sealed to: each whose node has a box key, never the agents' Mac. */
export const boxesOf = (machines: ReadonlyArray<Pick<Machine, "machineId" | "boxPubKey" | "agentsMac">>): { machineId: string; boxPubKey: string }[] =>
  machines
    .flatMap((m) => (typeof m.boxPubKey === "string" && m.agentsMac !== true && fromBase64(m.boxPubKey)?.length === 32 ? [{ machineId: m.machineId, boxPubKey: m.boxPubKey }] : []))
    .sort((a, b) => a.machineId.localeCompare(b.machineId));

/** What the key field keeps: one line, no spaces or quotes; null when it isn't a key. */
export const keyOf = (typed: string): string | null => {
  const v = typed.trim().replace(/^["']|["']$/gu, "");
  return v === "" || /\s/u.test(v) ? null : v;
};

/** An endpoint the hub takes: http or https, no spaces. */
export const endpointOk = (typed: string): boolean => typed.trim() === "" || /^https?:\/\/\S{1,500}$/u.test(typed.trim());

/** `key` sealed to each box, as claude_hub_api_set takes it; `random(32)` makes each one-time key. */
export const sealEach = (key: string, boxes: ReadonlyArray<{ machineId: string; boxPubKey: string }>, random: (n: number) => Uint8Array): { machineId: string; sealed: string }[] =>
  boxes.map((b) => ({ machineId: b.machineId, sealed: toBase64(seal(utf8Encode(key), fromBase64(b.boxPubKey) as Uint8Array, keyPairOf(random(32)))) }));

/** The row's value on Settings, and the section's footer here: where the key is, through what. */
export const keyWords = (api: ClaudeHubApi | undefined): { value: string; footer?: string } => {
  if (api === undefined) return { value: "Not Set" };
  const on = api.sealedOn.map((s) => (s.machineId === "hosted" ? "hosted sandboxes" : s.machineId));
  const sealed = on.length === 0 ? "On no machine yet." : `Sealed on ${on.join(", ")}.`;
  return { value: api.lastTest?.ok === false ? "Failed" : "Set", footer: api.endpoint === undefined ? sealed : `${sealed} Through ${api.endpoint}.` };
};
