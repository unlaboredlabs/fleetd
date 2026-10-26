// W58's design preview, try it yourself: storefront as the typical fixture has it, with #14 (checkout buttons in German
// and Dutch) written by an agent, so feedback has agents to go to. The previews, the device, the feedback and the
// sign-off come from the renderer's preview store (src/renderer/screens/tryit/preview.ts), which shows only under
// this fixture.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { isObject, type JsonValue } from "../kit/json.ts";

const BRANCH = "fleetd/T14-checkout-buttons-de-nl";

/** #14's row and detail, wherever they are in `v`, as an agent's PR on its fleetd branch. */
const agents14 = (v: JsonValue): JsonValue => {
  if (Array.isArray(v)) return v.map(agents14);
  if (!isObject(v)) return v;
  const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, agents14(x)]));
  if (out["number"] !== 14 || !("title" in out)) return out;
  return {
    ...out,
    branch: BRANCH,
    author: { role: "implementer", title: "Checkout buttons in German and Dutch", profile: "high", login: "acme-fleet" },
  };
};

const preview = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "tryit-preview", "Try it yourself: storefront's #14 tried on the web and on an Android emulator, marked up, and waiting on your sign-off.");
  for (const tool of ["pr_list", "pr_get"]) f.update(tool, agents14);
  f.update("pr_get", (out, input) =>
    input?.["number"] === 14 && isObject(out)
      ? { ...out, body: "The pay and back buttons read naturally in German, and checkout gets its Dutch copy.\n\n- `src/i18n/checkout.json`: de and nl strings for the checkout's three buttons.\n- The Android app reads the same file." }
      : out,
  );
  return f;
};

export default defineGroup({
  fixtures: (base) => [preview(base("typical"))],
});
