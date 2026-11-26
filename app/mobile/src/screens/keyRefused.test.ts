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
    const again = settings.indexOf("{hub.phase === \"refused\" ? <ListRow title={`Pair This ${DEVICE} Again`} onPress={forget} /> : null}");
    expect(status).toBeGreaterThan(0);
    expect(again).toBeGreaterThan(status);
    expect(settings.slice(status, again)).not.toContain("</ListSection>");
  });
});
