#!/usr/bin/env node
import { run, runLongRunning } from "./cli.ts";
import { isLeadCommand, leadCommand } from "./lead.ts";

const argv = process.argv.slice(2);
const longRunning = runLongRunning(argv);
if (longRunning !== undefined) {
  process.exitCode = await longRunning;
} else {
  const result = isLeadCommand(argv) ? await leadCommand(argv, { env: process.env, cwd: process.cwd() }) : run(argv);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
