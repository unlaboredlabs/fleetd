// The chat's Artifacts (W367). artifacts-published: storefront's chat, where its sweep agent published a dependency
// sweep twice (Markdown; version 2 is the newest) and the lead a chart of build times (HTML, drawn by its own script);
// each left a card in the chat, and the lead's last message links to both; the tab lists two files sent in the chat
// under them. artifacts-none: a hub that serves
// Artifacts, none published yet.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { type Draft, writeChat } from "../kit/chat.ts";
import { at } from "../kit/ids.ts";
import { AGENT } from "../agents/route.ts";
import { BUILD_TIMES_HTML } from "./chart.ts";

const STOREFRONT = { machineId: AGENT.machineId, projectId: AGENT.projectId };
const SWEEPER = "Sweep the dependencies";

const SWEEP_V1 = `# Dependency sweep

12 of 148 packages are behind their newest release; 2 have advisories.

| Package | Pinned | Newest | Why it matters |
|---|---|---|---|
| \`undici\` | 6.19.8 | 6.21.2 | An advisory: a crafted redirect can leak a header |
| \`cookie\` | 0.6.0 | 0.7.2 | An advisory: names and paths aren't escaped |
| \`zod\` | 4.1.5 | 4.6.7 | Faster parsing; nothing breaking |
| \`pino\` | 9.4.0 | 9.9.0 | Smaller install |

## Next

- Bump the two with advisories first, alone, so a revert is small.
- The other ten in one PR after them.
`;

const SWEEP_V2 = `# Dependency sweep

Every package is current. The two advisories are fixed and the other ten bumped, in two PRs.

| Package | Was | Now | PR |
|---|---|---|---|
| \`undici\` | 6.19.8 | 6.21.2 | #412 |
| \`cookie\` | 0.6.0 | 0.7.2 | #412 |
| \`zod\` | 4.1.5 | 4.6.7 | #415 |
| \`pino\` | 9.4.0 | 9.9.0 | #415 |

## What changed

- **Advisories:** none left (\`npm audit\` is clean).
- **Build:** the server bundle is 180 KB smaller.
- **Tests:** all green on both PRs; nothing needed a code change.

## Left for later

\`drizzle-orm\` 1.0 changes its query builder; it waits for its own order.
`;

const version = (n: number, title: string, format: "md" | "html", by: string, minutesAgo: number, content: string, now: string) => ({
  version: n,
  title,
  format,
  by,
  at: at(now, -minutesAgo * 60_000),
  bytes: Buffer.byteLength(content),
});

const published = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "artifacts-published", "Artifacts: an agent's Markdown sweep in two versions and the lead's HTML chart, their cards in the chat and a message linking to them.");
  if (f.state.phase === "live") f.state = { ...f.state, features: [...(f.state.features ?? []), "artifacts"] };
  const sweep = [version(2, "Dependency sweep", "md", SWEEPER, 6, SWEEP_V2, f.now), version(1, "Dependency sweep", "md", SWEEPER, 42, SWEEP_V1, f.now)];
  const chart = version(1, "Build times", "html", "Lead", 24, BUILD_TIMES_HTML, f.now);
  const card = (name: string, v: { version: number; title: string; format: string; by: string }) => ({ artifact: { name, version: v.version, title: v.title, format: v.format, by: v.by } });
  const [v2, v1] = sweep as [ReturnType<typeof version>, ReturnType<typeof version>];
  const drafts: Draft[] = [
    { author: "human", text: "can you sweep the deps and show me where the build time goes?", minutesAgo: 50 },
    { author: "lead", text: "on it: one agent sweeps the packages, I'll chart the builds", minutesAgo: 49 },
    { author: "system", text: `${SWEEPER} published Dependency sweep`, extra: card("dependency-sweep", v1), minutesAgo: 42 },
    { author: "system", text: "Lead published Build times", extra: card("build-times", chart), minutesAgo: 24 },
    { author: "system", text: `${SWEEPER} published Dependency sweep, version 2`, extra: card("dependency-sweep", v2), minutesAgo: 6 },
    {
      author: "lead",
      text: "sweep's done, every package is current and both advisories are fixed: [Dependency sweep](artifact:dependency-sweep). The first pass is still there as [version 1](artifact:dependency-sweep@1).\n\nmost of the build is the release link step, see [Build times](artifact:build-times)",
      minutesAgo: 5,
    },
  ];
  writeChat(f, STOREFRONT, drafts);
  const files = [
    { attachmentId: "F12", name: "build-profile.csv", mime: "text/csv", bytes: 18_432, at: at(f.now, -23 * 60_000) },
    { attachmentId: "F9", name: "checkout-before.png", mime: "image/png", bytes: 412_877, at: at(f.now, -51 * 60_000) },
  ];
  f.answer("artifacts_list", { projectRef: STOREFRONT }, { artifacts: [{ name: "dependency-sweep", newest: v2 }, { name: "build-times", newest: chart }], files });
  const get = (name: string, versions: Array<ReturnType<typeof version>>, texts: Record<number, string>) => {
    const newest = versions[0];
    if (newest === undefined) return;
    f.answer("artifact_get", { projectRef: STOREFRONT, name }, { name, artifact: newest, content: texts[newest.version] ?? "", versions });
    for (const v of versions) f.answer("artifact_get", { projectRef: STOREFRONT, name, version: v.version }, { name, artifact: v, content: texts[v.version] ?? "", versions });
  };
  get("dependency-sweep", sweep, { 1: SWEEP_V1, 2: SWEEP_V2 });
  get("build-times", [chart], { 1: BUILD_TIMES_HTML });
  return f;
};

const none = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "artifacts-none", "Artifacts: a hub that serves them, none published in this chat yet.");
  if (f.state.phase === "live") f.state = { ...f.state, features: [...(f.state.features ?? []), "artifacts"] };
  f.answer("artifacts_list", { projectRef: STOREFRONT }, { artifacts: [], files: [] });
  return f;
};

export default defineGroup({
  fixtures: (base) => [published(base("many-agents")), none(base("chat-waiting"))],
});
