// `vault_adopt` (vault-design §7): the migration into the vault takes what this node holds, each value sealed to the
// hub's box key (`to`) as its raw UTF-8 bytes, so it never crosses the hub's link, logs or memory in the clear: every
// project variable (`project-env/<project>.json`), every order variable (`order-env/<project>/<order>.json`) and every
// `env:` and `file:` sink (`secret-sinks.json`, each value read from its sink). Both runtimes write the same file
// shapes. The files stay where they are: the vault delivers to them. A file or sink that can't be read is left out
// and logged by its path, never by its value; the hub counts it as waiting and asks again on the next link.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { VaultAdoptSink, VaultAdoptVar } from "../../shared/sessions.ts";
import { seal } from "../../shared/sealed_box.ts";
import { readSecret, type SecretsContext } from "./index.ts";
import { fingerprintOf } from "./files.ts";

type ProjectFile = { vars?: Record<string, { value?: unknown; secret?: unknown }> };
type OrderFile = { vars?: Record<string, unknown> };
type SinkIndex = Record<string, { kind?: unknown; path?: unknown; envName?: unknown }>;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PLAIN_ID = /^[A-Za-z0-9_-]+$/;
const ORDER_ID = /^W[1-9][0-9]{0,9}$/;

const json = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    console.warn(`vault_adopt: ${path} left out: ${(e as { code?: string }).code ?? "it does not parse"}`);
    return undefined;
  }
};

const names = (dir: string) => {
  try {
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  } catch (e) {
    console.warn(`vault_adopt: ${dir} left out: ${(e as { code?: string }).code ?? String(e)}`);
    return [];
  }
};

/** A file's variables by name, as the Rust node's BTreeMap keeps them. */
const sorted = <T>(vars: Record<string, T> | undefined): [string, T][] => Object.entries(vars ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Everything the node holds for the vault, each value sealed to `to` (the hub's box public key, base64). */
export function adopt(ctx: Pick<SecretsContext, "home" | "roots" | "machineId">, to: string): { vars: VaultAdoptVar[]; sinks: VaultAdoptSink[] } {
  const hub = Buffer.from(to, "base64");
  if (hub.length !== 32) throw new Error("the hub's box key is not 32 bytes");
  const sealed = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    try {
      return Buffer.from(seal(hub, bytes)).toString("base64");
    } finally {
      bytes.fill(0);
    }
  };
  const one = (value: string) => ({ sealed: sealed(value), fingerprint: fingerprintOf(value), bytes: Buffer.byteLength(value) });
  const vars: VaultAdoptVar[] = [];
  const projects = join(ctx.home, "project-env");
  for (const file of names(projects).filter((f) => f.endsWith(".json"))) {
    const projectId = file.slice(0, -5);
    if (!PLAIN_ID.test(projectId)) continue;
    const read = json<ProjectFile>(join(projects, file));
    for (const [name, entry] of sorted(read?.vars)) {
      if (!NAME.test(name) || typeof entry?.value !== "string") continue;
      vars.push({ scope: "project", projectId, name, secret: entry.secret === true, ...one(entry.value) });
    }
  }
  const orders = join(ctx.home, "order-env");
  for (const projectId of names(orders).filter((p) => PLAIN_ID.test(p))) {
    for (const file of names(join(orders, projectId)).filter((f) => f.endsWith(".json"))) {
      const orderId = file.slice(0, -5);
      if (!ORDER_ID.test(orderId)) continue;
      const read = json<OrderFile>(join(orders, projectId, file));
      for (const [name, value] of sorted(read?.vars)) {
        if (!NAME.test(name) || typeof value !== "string") continue;
        // An order's variables were always secrets: each came from a person's sealed answer, or fleetd's own token.
        vars.push({ scope: "order", projectId, orderId, name, secret: true, ...one(value) });
      }
    }
  }
  const sinks: VaultAdoptSink[] = [];
  const indexFile = join(ctx.home, "secret-sinks.json");
  const index = existsSync(indexFile) ? (json<SinkIndex>(indexFile) ?? {}) : {};
  for (const secretKey of Object.keys(index).sort()) {
    const record = index[secretKey]!;
    if ((record.kind !== "env" && record.kind !== "file") || typeof record.path !== "string") continue;
    let value: string;
    try {
      value = readSecret(secretKey, ctx);
    } catch (e) {
      console.warn(`vault_adopt: the ${record.kind}: sink ${record.path} left out: ${(e as Error).message}`);
      continue;
    }
    const { sealed: box, fingerprint } = one(value);
    sinks.push({
      secretKey,
      kind: record.kind,
      path: record.path,
      ...(typeof record.envName === "string" ? { envName: record.envName } : {}),
      sealed: box,
      fingerprint,
    });
  }
  return { vars, sinks };
}
