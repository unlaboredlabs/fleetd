// Chats' pictures (project_avatar_set). avatars-set: Ada and Home, Navis, with a portrait and a landscape, and
// storefront with its logo, in the sidebar, the chat's title and Settings › Projects › Icon; the other projects keep
// their letters. The pictures are the JPEGs beside this file, as the hub keeps one: 512 px square. avatars-icons: every
// project and Navi wears a built-in icon, as a hub sends them (project_icon_set, or one derived from its id), and
// storefront's settings page has the picker.
import fs from "node:fs";
import path from "node:path";
import { writeChat, type Ref } from "../kit/chat.ts";
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import { asText, isObject } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";
import { navi } from "../navi/index.ts";
import { ADA, HOME } from "../navi/ids.ts";

const picture = (name: string): string => fs.readFileSync(path.join(import.meta.dirname, `${name}.jpg`)).toString("base64");

/** Gives the project its picture: its summary names it, and project_avatar_get answers its bytes. */
const give = (f: Fixture, ref: Ref, avatar: string, file: string): void => {
  const p = arr(f.snapshot?.["projects"]).filter(isObject).find((x) => x["machineId"] === ref.machineId && x["projectId"] === ref.projectId);
  if (p === undefined) throw new Error(`no project ${ref.projectId}`);
  p["avatar"] = avatar;
  f.answer("project_avatar_get", { ...ref }, { avatar, mime: "image/jpeg", dataB64: picture(file) });
};

const avatars = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "avatars-set", "Chats' pictures: Ada, Home and storefront have one; the other projects their letters.");
  if (f.snapshot === undefined) throw new Error("avatars needs a snapshot");
  f.snapshot["projects"] = [...arr(f.snapshot["projects"]), navi(f, ADA, "Ada", "ada"), navi(f, HOME, "Home", "home")];
  writeChat(f, ADA, [
    { author: "human", text: "Ana asked about lunch on Tuesday. Say yes, 12:30 at the usual place." },
    { author: "lead", text: "Tuesday 12:30 is free on your calendar. I said yes and booked the usual table for two." },
  ]);
  f.answer("checklist_get", { projectRef: { ...ADA } }, {
    projectRef: { ...ADA },
    items: [{ id: 1, text: "Book a table for two at 12:30", state: "done", updatedAt: at(f.now, -120_000) }],
    updatedAt: at(f.now, -120_000),
  });
  const storefront = arr(f.snapshot["projects"]).filter(isObject).find((p) => p["title"] === "storefront");
  if (storefront === undefined) throw new Error("avatars needs storefront");
  give(f, ADA, "a1b2c3d4e5f60718", "ada");
  give(f, HOME, "0f1e2d3c4b5a6978", "home");
  const shop = { machineId: asText(storefront["machineId"]), projectId: asText(storefront["projectId"]) };
  give(f, shop, "5a7e0c1d2b3f4a69", "storefront");
  // Its settings page, where its Picture is.
  f.answer("project_settings_get", { ...shop }, {
    settings: { ...shop, title: "storefront", workspaceRoot: "/home/dev/src/storefront", setup: { commands: [], timeoutSec: 600, runAnyway: false, inputs: [] }, env: [] },
  });
  return f;
};

/** The icons avatars-icons's projects wear, in the snapshot's order. */
const ICONS: readonly (readonly [string, string])[] = [
  ["wink", "fleet"],
  ["mo", "mint"],
  ["wow", "sun"],
  ["peep", "plum"],
  ["nap", "sky"],
  ["joy", "ember"],
  ["cy", "teal"],
  ["huh", "rose"],
  ["wee", "lilac"],
  ["mo", "graphite"],
  ["wink", "lime"],
  ["peep", "sand"],
];

const icons = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "avatars-icons", "Chats' icons: every project and Navi wears a built-in one.");
  if (f.snapshot === undefined) throw new Error("icons needs a snapshot");
  f.snapshot["projects"] = [...arr(f.snapshot["projects"]), navi(f, ADA, "Ada", "ada"), navi(f, HOME, "Home", "home")];
  arr(f.snapshot["projects"])
    .filter(isObject)
    .forEach((p, i) => {
      const [face, color] = ICONS[i % ICONS.length] ?? ["mo", "fleet"];
      p["icon"] = { face, color };
    });
  const storefront = arr(f.snapshot["projects"]).filter(isObject).find((p) => p["title"] === "storefront");
  if (storefront === undefined) throw new Error("icons needs storefront");
  const shop = { machineId: asText(storefront["machineId"]), projectId: asText(storefront["projectId"]) };
  f.answer("project_settings_get", { ...shop }, {
    settings: { ...shop, title: "storefront", workspaceRoot: "/home/dev/src/storefront", setup: { commands: [], timeoutSec: 600, runAnyway: false, inputs: [] }, env: [] },
  });
  // Its picker's pick of Wow in Sun.
  const icon = { face: "wow", color: "sun" };
  f.answer("project_icon_set", { ...shop, icon }, { project: { ...storefront, icon } });
  return f;
};

export default defineGroup({
  fixtures: (base) => [avatars(base("chat-waiting")), icons(base("chat-waiting"))],
});
