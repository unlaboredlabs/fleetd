// The hosted sandbox template, built from scratch at boat.dev as a runner builds it the first time (the recipe of
// src/node/sandbox/remote/boxes.ts on boat's current base image), then deleted. A runner builds it only when its
// account has none, so a break from outside (a source in boat's image, an unpinned download) would otherwise show
// first when someone's new bot can't start. The Nightly workflow runs it with a boat.dev key of fleetd's own
// (BOAT_API_KEY); without one it says so and stops. The key never goes to the output: the client masks it.
import base from "../src/sandbox/image/Dockerfile" with { type: "text" };
import { boat } from "../src/sandbox/providers/boat.ts";
import { hosted, templateName } from "../src/sandbox/providers/recipe.ts";
import { TESTED } from "../src/node/runner/claude.ts";

const key = process.env.BOAT_API_KEY ?? "";
if (!key) {
  console.log("::warning::hosted-template-check: no BOAT_API_KEY secret, so the hosted template isn't checked");
  process.exit(0);
}
const recipe = hosted(base, { claude: TESTED });
// Not the runners' name: a check never answers for a template a team's runner uses.
const name = `${templateName(recipe).replace(/^fleetd-/, "fleetd-check-")}-${crypto.randomUUID().slice(0, 8)}`;
const client = boat({ key });
const started = Date.now();
try {
  await client.build(recipe, { name, onLog: (line) => console.log(`hosted-template-check: ${line}`) });
  console.log(`hosted-template-check: built ${name} in ${Math.round((Date.now() - started) / 1000)} s`);
} catch (error) {
  console.error(`hosted-template-check: the template didn't build: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await client.forget?.(name).catch((error: Error) => console.error(`hosted-template-check: ${name} wasn't deleted: ${error.message}`));
}
