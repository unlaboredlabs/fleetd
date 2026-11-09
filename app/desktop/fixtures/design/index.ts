// W580 design exploration, temporary: the sidebar's list for the design proposal (qa/design/capture.ts). status-rows'
// eight projects, each bot in its own colour, with one, two and three chats pinned, a pair with long names, and the same
// under two hubs.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { asText, isObject, type JsonObject } from "../kit/json.ts";
import { arr, obj } from "../kit/stress.ts";
import { BOT_COLORED, retitle } from "../sidebar/index.ts";

const colored = (f: Fixture): Fixture => {
  if (f.snapshot !== undefined) {
    f.snapshot["projects"] = arr(f.snapshot["projects"]).map((p) => {
      const title = asText(obj(p)["title"]);
      const color = Object.entries(BOT_COLORED).find(([t]) => title.startsWith(t))?.[1];
      return color === undefined ? p : { ...obj(p), avatarColor: color };
    });
  }
  return f;
};

const pin = (f: Fixture, titles: readonly string[]): Fixture => {
  const projects = arr(f.snapshot?.["projects"]).filter(isObject);
  const ref = (title: string): JsonObject => {
    const p = projects.find((x) => asText(x["title"]).startsWith(title));
    if (p === undefined) throw new Error(`no project ${title}`);
    return { machineId: p["machineId"] ?? "", projectId: p["projectId"] ?? "" };
  };
  return f.answer("chat_pins_get", {}, { pins: titles.map(ref), set: true });
};

const PINS = {
  "design-pins-none": [],
  "design-pins-one": ["storefront"],
  "design-pins-two": ["storefront", "billing"],
  "design-pins-three": ["storefront", "billing", "docs"],
  "design-pins-long": ["Rewrite the pricing", "garden-sensors"],
} as const;

export default defineGroup({
  fixtures: (base) => {
    const one = Object.entries(PINS).map(([name, titles]) => {
      const f = colored(Fixture.from(base("status-rows"), name, `Design: the sidebar with ${String(titles.length)} pinned.`));
      if (name === "design-pins-long") retitle(f, { inventory: "garden-sensors" });
      return pin(f, titles);
    });
    // Two hubs: Personal's three projects, one pinned, and Acme's eight, two pinned.
    const hubs = Fixture.from(base("typical"), "design-hubs", "Design: two hubs, each with pins.");
    retitle(hubs, { storefront: "blog", billing: "garden-sensors", checkout: "recipes" });
    hubs.label = "Personal";
    hubs.color = "green";
    pin(hubs, ["blog"]);
    const acme = pin(colored(Fixture.from(base("status-rows"), "design-hubs-acme", "Acme")), ["storefront", "billing"]);
    acme.state = { phase: "live", hub: "https://hub.acme.example", protocol: hubs.state.phase === "live" ? hubs.state.protocol : 1 };
    hubs.hubs = [{ label: "Acme", color: "amber", fixture: acme }];
    return [...one, hubs];
  },
});
