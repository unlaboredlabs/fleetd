// Secret requests and a project's secret environment variables: the value is sealed here, in main, to the sink machine's X25519 box key with libsodium's
// crypto_box_seal (the same construction as the node's crypto_box_seal_open and the old app's seal.rs), so the hub
// only relays ciphertext and the renderer never gets the plaintext back. It is never logged.
import { SECRET_MAX_BYTES, type EnvVarSet, type McpValueSet, type ToolInput } from "../shared/contracts";
import type { CallOutcome, HubError, SecretOutcome } from "../shared/hub";
import type { GoogleClientRequest, GooglePubsubRequest, HubLinkRequest, McpServerRequest, ProjectEnvRequest, SecretRequest } from "../shared/ipc";


const refused = (message: string, fix?: string): { ok: false; error: HubError } => ({
  ok: false,
  error: { code: "invalid", message, ...(fix === undefined ? {} : { fix }) },
});

/** Standard base64 of `crypto_box_seal(value)` for `boxPubKey` (standard base64 of 32 bytes), or why not. */
export const seal = async (boxPubKey: string, value: string): Promise<{ ok: true; sealed: string } | { ok: false; error: HubError }> => {
  const plain = new TextEncoder().encode(value);
  try {
    if (plain.length === 0) return refused("The secret is empty.", "Type or paste the value, then send it.");
    if (plain.length > SECRET_MAX_BYTES) {
      return refused(`The secret is over ${SECRET_MAX_BYTES} bytes.`, "Send a shorter value, or put a file on the machine and send its path.");
    }
    const key = Buffer.from(boxPubKey.trim(), "base64");
    if (key.length !== 32 || key.toString("base64") !== boxPubKey.trim()) {
      return refused("The machine's box key is not a 32-byte key.", "Restart the node on that machine so it reports its key again.");
    }
    // Loaded on the first secret, not at startup: libsodium instantiates its WebAssembly on import.
    const { default: sodium } = await import("libsodium-wrappers");
    await sodium.ready;
    return { ok: true, sealed: Buffer.from(sodium.crypto_box_seal(plain, key)).toString("base64") };
  } finally {
    plain.fill(0);
  }
};

/** Seals, then hands the box to secret_submit. Only the node's fingerprint of the value comes back. */
export const submitSecret = async (
  request: SecretRequest,
  // Typed against the generated contracts, so a renamed tool or field fails typecheck instead of the hub call.
  call: (tool: "secret_submit", input: ToolInput<"secret_submit">) => Promise<CallOutcome>,
): Promise<SecretOutcome> => {
  const sealed = await seal(request.boxPubKey, request.value);
  if (!sealed.ok) return sealed;
  const out = await call("secret_submit", { requestId: request.requestId, sealed: sealed.sealed });
  if (!out.ok) return out;
  const fingerprint = (out.output as { fingerprint?: unknown } | null)?.fingerprint;
  return { ok: true, fingerprint: typeof fingerprint === "string" ? fingerprint : "" };
};

/**
 * A link key pasted into a Navi's Linked hubs: sealed to the hub's own key (hub_links_get's boxPubKey), then
 * hub_link_add. A link key is "flk_" and 52 base32 characters; anything else is refused here, before it goes anywhere.
 */
export const submitHubLink = async (
  request: HubLinkRequest,
  call: (tool: "hub_link_add", input: ToolInput<"hub_link_add">) => Promise<CallOutcome>,
): Promise<CallOutcome> => {
  if (!/^flk_[a-z2-7]{52}$/u.test(request.key)) {
    return refused("That isn't a link key.", "Paste the key from the other hub's Settings › Hubs, Links to this hub: it starts with flk_.");
  }
  const sealed = await seal(request.boxPubKey, request.key);
  if (!sealed.ok) return sealed;
  return call("hub_link_add", { navi: request.navi, label: request.label, url: request.url, sealed: sealed.sealed });
};

/**
 * A project's environment changes: each secret's value sealed to the project machine's key, then project_env_set.
 * Plain values go as typed. The hub's answer lists the variables with a secret's fingerprint, never its value.
 */
export const submitProjectEnv = async (
  request: ProjectEnvRequest,
  call: (tool: "project_env_set", input: ToolInput<"project_env_set">) => Promise<CallOutcome>,
): Promise<CallOutcome> => {
  const set: EnvVarSet[] = [];
  for (const v of request.set) {
    if (v.kind === "plain") {
      set.push({ kind: "plain", name: v.name, value: v.value });
      continue;
    }
    // Any number of lines (a certificate chain, a service account's JSON); only a NUL can't be in an environment.
    if (v.value.includes("\0")) return refused(`${v.name}'s value holds a NUL character.`, "Remove it, then save.");
    if (request.boxPubKey === undefined) {
      return refused("The project's machine takes no secrets yet: its node has no box key.", "Update fleetd on that machine, then save.");
    }
    const sealed = await seal(request.boxPubKey, v.value);
    if (!sealed.ok) return { ok: false, error: { ...sealed.error, message: `${v.name}: ${sealed.error.message}` } };
    set.push({ kind: "secret", name: v.name, sealed: sealed.sealed });
  }
  return call("project_env_set", { machineId: request.machineId, projectId: request.projectId, set, remove: request.remove });
};

/**
 * An MCP server to save: each secret value sealed to every machine in `boxes` (a project server's machine, or every
 * machine for a global one), then mcp_server_set. Plain values and kept secrets go as they are. The hub's answer has
 * the server with a secret by the machines that hold it, never its value.
 */
export const submitMcpServer = async (
  request: McpServerRequest,
  call: (tool: "mcp_server_set", input: ToolInput<"mcp_server_set">) => Promise<CallOutcome>,
): Promise<CallOutcome> => {
  const values = async (list: McpServerRequest["env"]): Promise<{ ok: true; set: McpValueSet[] } | { ok: false; error: HubError }> => {
    const set: McpValueSet[] = [];
    for (const v of list) {
      if (v.kind !== "secret") {
        set.push(v);
        continue;
      }
      if (v.value.includes("\0")) return refused(`${v.name}'s value holds a NUL character.`, "Remove it, then save.");
      if (request.boxes.length === 0) {
        return refused("No machine takes secrets yet: no node has a box key.", "Update fleetd on your machines, then save.");
      }
      const sealed: Array<{ machineId: string; sealed: string }> = [];
      for (const box of request.boxes) {
        const one = await seal(box.boxPubKey, v.value);
        if (!one.ok) return { ok: false, error: { ...one.error, message: `${v.name} for ${box.machineId}: ${one.error.message}` } };
        sealed.push({ machineId: box.machineId, sealed: one.sealed });
      }
      set.push({ kind: "secret", name: v.name, sealed });
    }
    return { ok: true, set };
  };
  const env = await values(request.env);
  if (!env.ok) return env;
  const headers = await values(request.headers);
  if (!headers.ok) return headers;
  const transport = request.transport.type === "stdio" ? { type: "stdio" as const, command: request.transport.command, args: request.transport.args } : request.transport;
  return call("mcp_server_set", {
    scope: request.scope,
    name: request.name,
    enabled: request.enabled,
    roles: request.roles,
    transport,
    env: env.set,
    headers: headers.set,
    ...(request.integration === undefined
      ? {}
      : { integration: { kind: request.integration.kind, ...(request.integration.readTools === undefined ? {} : { readTools: request.integration.readTools }) } }),
  });
};

/**
 * The hub's Google OAuth client: its secret sealed to every machine in `boxes`, then google_client_set. The hub keeps
 * the id and each node's fingerprint of the secret; nothing returns the secret.
 */
export const submitGoogleClient = async (
  request: GoogleClientRequest,
  call: (tool: "google_client_set", input: ToolInput<"google_client_set">) => Promise<CallOutcome>,
): Promise<CallOutcome> => {
  const secret = request.secret.trim();
  if (/\s/u.test(secret)) return refused("The client secret has a space or a line break in it.", "Copy it again from the client's page in Google Cloud Console.");
  const sealed: Array<{ machineId: string; sealed: string }> = [];
  for (const box of request.boxes) {
    const one = await seal(box.boxPubKey, secret);
    if (!one.ok) return { ok: false, error: { ...one.error, message: `For ${box.machineId}: ${one.error.message}` } };
    sealed.push({ machineId: box.machineId, sealed: one.sealed });
  }
  return call("google_client_set", { clientId: request.clientId, sealed });
};

/**
 * Real-time mail's service account key: checked to be one, sealed to the machine that reads the subscription, then
 * google_pubsub_set. Nothing returns the key; the hub keeps that machine's fingerprint of it.
 */
export const submitGooglePubsub = async (
  request: GooglePubsubRequest,
  call: (tool: "google_pubsub_set", input: ToolInput<"google_pubsub_set">) => Promise<CallOutcome>,
): Promise<CallOutcome> => {
  const fix = "Paste the whole JSON file from the service account's Keys › Add key › Create new key › JSON.";
  let key: unknown;
  try {
    key = JSON.parse(request.key);
  } catch {
    return refused("That isn't a JSON key.", fix);
  }
  const k = typeof key === "object" && key !== null ? (key as Record<string, unknown>) : {};
  if (k["type"] !== "service_account" || typeof k["private_key"] !== "string" || typeof k["client_email"] !== "string") {
    return refused("That isn't a service account's JSON key.", fix);
  }
  const sealed = await seal(request.boxPubKey, request.key.trim());
  if (!sealed.ok) return { ok: false, error: { ...sealed.error, message: `For ${request.machineId}: ${sealed.error.message}` } };
  return call("google_pubsub_set", { pubsub: { topic: request.topic, subscription: request.subscription, machineId: request.machineId, sealed: sealed.sealed } });
};
