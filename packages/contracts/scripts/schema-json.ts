// Writes JSON Schema (draft 2020-12) for the app-facing types to packages/contracts/schema/.
// The Rust app validates against these; a contracts test fails when they are out of date.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JsonSchema, Schema } from "effect";
import {
  AppClientMessage,
  AppServerMessage,
  HubEvent,
  Machine,
  ProjectOutcome,
  ProjectSummary,
  ThreadSummary,
} from "../src/index.ts";

export const schemaDir = fileURLToPath(new URL("../schema/", import.meta.url));

const appFacing = { HubEvent, Machine, ProjectSummary, ThreadSummary, ProjectOutcome, AppClientMessage, AppServerMessage };

/** File name -> file contents. */
export function renderJsonSchemas(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(appFacing).map(([name, schema]) => {
      const doc = Schema.toJsonSchemaDocument(schema);
      const standalone = { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12, ...doc.schema, $defs: doc.definitions };
      return [`${name}.json`, `${JSON.stringify(standalone, null, 2)}\n`];
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(schemaDir, { recursive: true });
  for (const [file, text] of Object.entries(renderJsonSchemas())) writeFileSync(`${schemaDir}${file}`, text);
  console.log(`wrote ${Object.keys(appFacing).length} schemas to ${schemaDir}`);
}
