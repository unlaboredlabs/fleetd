// A key the workspace refused: the alert's Not Now leaves Settings saying "Key refused", and the way to pair again is
// right there under it, not only Disconnect at the foot of the page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const settings = readFileSync(join(import.meta.dirname, "Settings.tsx"), "utf8");

describe("Settings with a refused key", () => {
  it("offers to pair again under the status that says so", () => {
    // Seen on the Duo: after Not Now, Status read "Key refused" and nothing near it could be pressed.
    const status = settings.indexOf('<ListRow title="Status"');
    const again = settings.indexOf("{hub.phase === \"refused\" ? <ListRow title={pairAgainTitle(DEVICE)} onPress={forget} chevron={false} /> : null}");
    expect(status).toBeGreaterThan(0);
    expect(again).toBeGreaterThan(status);
    expect(settings.slice(status, again)).not.toContain("</ListSection>");
  });

  it("asks once per refusal, not again as a repair forgets the hub", () => {
    // Seen on the Duo: after Pair Again from the workspace's link had paired with a new key, the old key's alert came
    // back over the new session (its effect ran again as the hubs kept changed).
    const app = readFileSync(join(import.meta.dirname, "..", "..", "App.tsx"), "utf8");
    expect(app).toContain("if (refused === undefined || leaving.current || alerted.current === refused) return;");
  });
});
