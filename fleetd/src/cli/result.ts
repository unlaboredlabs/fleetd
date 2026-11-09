// What a short-lived command prints and exits with.
export type CliResult = { code: number; stdout: string; stderr: string };

export const ok = (stdout: string): CliResult => ({ code: 0, stdout, stderr: "" });
export const err = (code: number, stderr: string): CliResult => ({ code, stdout: "", stderr });

/** Writes a result's output; its exit code. */
export function emit(result: CliResult): number {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}
