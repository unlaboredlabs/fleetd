// How the project-style commands talk (`Stop`, `call`): a line per step,
// cliclack style in a terminal, plain lines otherwise; a stop is what went wrong, its fix and the exit code.
import { readFileSync } from "node:fs";
import { eprintln, println } from "./common.ts";
import { LiveHubCallRefused, type McpClient } from "./mcp_client.ts";
import * as tty from "./tty.ts";

/** What went wrong, the fix, and the exit code: 1 failed, 2 usage, 3 refused, 4 the hub or machine is unreachable. */
export class Stop extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
  }

  static fromBody(body: any): Stop {
    const text = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : undefined);
    return new Stop(text("code") === "machine_offline" ? 4 : 3, text("message") ?? JSON.stringify(body), text("fix"));
  }
}

export class Out {
  constructor(readonly tty: boolean) {}
  info(text: string) {
    if (this.tty) tty.log.info(text);
    else println(text);
  }
  success(text: string) {
    if (this.tty) tty.log.success(text);
    else println(`✓ ${text}`);
  }
  fail(stop: Stop): number {
    const fix = stop.fix === undefined ? "" : `\n  Fix: ${stop.fix}`;
    if (this.tty) tty.log.error(`${stop.message}${fix}`);
    else eprintln(`✗ ${stop.message}${fix}`);
    return stop.code;
  }
}

const CALL_MS = 120_000;

/** One tool call; its error result as a Stop, a transport failure as exit 4. */
export async function call(client: McpClient, tool: string, input: unknown): Promise<any> {
  let result;
  try {
    result = await client.callTool(tool, input, CALL_MS);
  } catch (error) {
    if (error instanceof LiveHubCallRefused) throw new Stop(3, error.message);
    throw new Stop(4, `${tool} failed: ${(error as Error).message}`);
  }
  if (result.isError) throw Stop.fromBody(result.body);
  return result.body;
}

/** A key file's key, trimmed; `undefined` and the io error's words when it can't be read. */
export function readKey(file: string): string | Error {
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    return error as Error;
  }
}

/** Drops the `undefined` fields of an input object, as serde's `json!` would keep them as `null`. */
export const input = (o: Record<string, unknown>) => o;
