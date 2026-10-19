// The board's own fixtures: the stage mid-run (PR groups with their checkers, checks landing, one writer still
// writing) and the finish (every PR merged, the lead closing). Both start from the typical lab hub, with its
// snapshot, and replace the board answer, the open asks and the live feed with a scene.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject, JsonValue } from "../kit/json.ts";
import { type Scene, finish, pointAt, stage } from "./scenes.ts";

const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue;

const fromScene = (base: Fixture, make: (now: number) => Scene): Fixture => {
  const now = Date.parse(base.now);
  const projects = base.snapshot?.["projects"];
  const first = Array.isArray(projects) ? (projects[0] as JsonObject | undefined) : undefined;
  if (typeof first?.["machineId"] === "string" && typeof first["projectId"] === "string") {
    pointAt({ machineId: first["machineId"], projectId: first["projectId"] });
  }
  const scene = make(now);
  const f = Fixture.from(base, scene.name, scene.note);
  // Only the project the scene's order belongs to has a board; the others answer empty.
  for (const { input } of f.answers("orders_board")) f.drop("orders_board", input);
  f.answer("orders_board", {}, json(scene.board));
  f.answer("asks_list", { state: "open" }, { batches: [], asks: [] });
  for (const order of scene.board.orders) {
    f.answer("order_get", { workstreamId: order.workstreamId }, json({ order, doneLanes: scene.done[order.workstreamId] ?? [], asks: [] }));
  }
  f.live = scene.live.map((frame) => json(frame) as JsonObject);
  return f;
};

export default defineGroup({
  fixtures: (base) => [fromScene(base("typical"), stage), fromScene(base("typical"), finish)],
});
