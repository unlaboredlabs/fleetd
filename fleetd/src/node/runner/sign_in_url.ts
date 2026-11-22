// Where a login command (`claude auth login`, `agy acp --login`) prints the page to sign in at. Pure: the node's login
// (./login.ts) and a box's (fleetd/box/antigravity) read its output alike.
export const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const URL = /https:\/\/[^\s\x07\x1b"'<>]+/g;

/** The URL to sign in at: the first that names OAuth, else the first; only a whole one, with something after it. */
export function signInUrl(output: string): string | undefined {
  const text = output.replace(CSI, "");
  const urls = [...text.matchAll(URL)].filter((m) => m.index! + m[0].length < text.length).map((m) => m[0]);
  return urls.find((u) => u.includes("oauth")) ?? urls[0];
}
