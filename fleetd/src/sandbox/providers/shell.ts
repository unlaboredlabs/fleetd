// A detached command for providers whose command API takes no environment of its own (boat's): the environment goes
// into a private file in the box first, by a call that keeps it out of the command's text (a file write), and the
// command reads and removes it before it runs. The command's text, which a provider may keep in its history, holds no value.

/** `s` quoted for sh. */
export const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** `text` for a log line or an error: every URL's query and fragment left out, so a signed link's signature never
 * reaches one. */
export const noQuery = (text: string) => text.replace(/(https?:\/\/[^\s?#]*)[?#]\S*/g, "$1?…");

/** Why `name` can't be an environment variable's name, or undefined. */
export const badName = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? undefined : `${JSON.stringify(name)} is not a variable name`);

/** `env` as a file sh sources: one `export NAME='value'` a line. */
export function envFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => {
      const bad = badName(k);
      if (bad) throw new Error(bad);
      return `export ${k}=${shq(v)}\n`;
    })
    .join("");
}

/** Where the environment file of one start goes: private to the box's user, gone once read. */
export const envPath = () => `/tmp/.fleetd-env-${crypto.randomUUID()}`;

/**
 * The command a provider runs detached: it sources and removes the environment file, moves to `cwd`, and becomes
 * `argv`, with no stdin and its output to `log`.
 */
export function launcher(argv: string[], o: { envAt?: string; cwd?: string; log?: string }): string {
  const steps: string[] = [];
  if (o.envAt) steps.push(`. ${shq(o.envAt)}`, `rm -f ${shq(o.envAt)}`);
  if (o.cwd) steps.push(`cd ${shq(o.cwd)}`);
  const log = shq(o.log ?? "/dev/null");
  steps.push(`exec ${argv.map(shq).join(" ")} </dev/null >>${log} 2>&1`);
  return `sh -c ${shq(steps.join(" && "))}`;
}
