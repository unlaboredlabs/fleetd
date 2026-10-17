#!/usr/bin/env node
import { run, runLongRunning } from "./cli.ts";

const argv = process.argv.slice(2);
const longRunning = runLongRunning(argv);
if (longRunning !== undefined) {
  process.exitCode = await longRunning;
} else {
  const result = run(argv);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
