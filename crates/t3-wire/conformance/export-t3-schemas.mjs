// Exports JSON Schema for the T3 RPC methods fleetd uses, from T3's own contracts, for `cargo xtask t3-conformance`.
// Usage: node export-t3-schemas.mjs <t3-checkout> <method-tag>...
// Prints {"<tag>": {"stream", "payload", "success", "error"} | null} to stdout; null means T3 no longer serves it.
// Imports the checkout's TypeScript sources directly (Node strips types), with the checkout's own effect.
import { pathToFileURL } from "node:url";

const [root, ...tags] = process.argv.slice(2);
if (!root || tags.length === 0) {
  console.error("usage: node export-t3-schemas.mjs <t3-checkout> <method-tag>...");
  process.exit(2);
}
const load = (rel) => import(pathToFileURL(`${root}/packages/contracts/${rel}`).href);
const contracts = await load("src/index.ts");
const Schema = await load("node_modules/effect/dist/Schema.js");
const RpcSchema = await load("node_modules/effect/dist/rpc/RpcSchema.js");

const doc = (schema) => {
  const d = Schema.toJsonSchemaDocument(schema);
  return { ...d.schema, $defs: d.definitions };
};

const out = {};
for (const tag of tags) {
  if (tag === "http:auth.webSocketTicket") {
    out[tag] = { stream: false, payload: null, success: doc(contracts.AuthWebSocketTicketResult), error: null };
    continue;
  }
  const rpc = contracts.WsRpcGroup.requests.get(tag);
  if (rpc === undefined) {
    out[tag] = null;
    continue;
  }
  const stream = RpcSchema.isStreamSchema(rpc.successSchema);
  out[tag] = {
    stream,
    payload: doc(rpc.payloadSchema),
    success: doc(stream ? rpc.successSchema.success : rpc.successSchema),
    error: doc(stream ? rpc.successSchema.error : rpc.errorSchema),
  };
}
process.stdout.write(JSON.stringify(out));
