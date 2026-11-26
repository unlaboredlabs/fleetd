// The commit identity a joining machine's agents get (S3): with none, the join's note asked for a fix on "the
// workspace's machine", which a cloud workspace has none of, and an agent committed as "fleetd T1 <noreply@anthropic.com>".
import { expect, test } from "bun:test";
import { joinIdentity } from "../../src/cli/setup/wizard.ts";

const person = { name: "Sam Rivers", email: "7+sam-dev@users.noreply.github.com" };
const own = { name: "Sam on the laptop", email: "sam@example.com" };

test("the join line's identity first, then the machine's own git user, else the workspace's name, never an id", () => {
  expect(joinIdentity(person, own, "https://sweep-9.fleetd.dev")).toEqual(person);
  expect(joinIdentity(undefined, own, "https://sweep-9.fleetd.dev")).toEqual(own);
  expect(joinIdentity(undefined, undefined, "https://sweep-9.fleetd.dev")).toEqual({ name: "sweep-9", email: "noreply@sweep-9.fleetd.dev" });
  expect(joinIdentity(undefined, undefined, "http://devbox.tailnet.ts.net:4790")).toEqual({ name: "devbox", email: "noreply@devbox.tailnet.ts.net" });
  // An address with no name in it names nothing.
  const fleetd = { name: "fleetd", email: "noreply@fleetd.invalid" };
  expect(joinIdentity(undefined, undefined, "not a url")).toEqual(fleetd);
  expect(joinIdentity(undefined, undefined, "http://127.0.0.1:4790")).toEqual(fleetd);
  expect(joinIdentity(undefined, undefined, "http://100.101.102.103:4790")).toEqual(fleetd);
  expect(joinIdentity(undefined, undefined, "http://[fd7a:115c:a1e0::1]:4790")).toEqual(fleetd);
});
