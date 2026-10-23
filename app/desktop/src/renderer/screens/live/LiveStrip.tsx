// The live strip after the lead's latest message (and after the field that answers it): one quiet line, "5 agents
// working" and the PRs they are on. The headline opens the panel's agents, where each agent's live work and steer box
// are, so the chat never draws them a second time; each PR opens in the panel too. Nothing is drawn when no agent is
// shown.
import { useData } from "../../src/data/react";
import { Text, Truncate } from "../../ui";
import { navigate } from "../shell/navigation";
import { panelRoute, toHash } from "../shell/routes";
import { type ProjectRef, selectStrip, stripHeadline, stripPrs } from "./strip";
import s from "./live.module.css";

export function LiveStrip({ project }: { project: ProjectRef }) {
  const strip = useData(selectStrip(project));
  if (strip === undefined || strip.agents === 0) return null;
  const headline = stripHeadline(strip);
  const prs = stripPrs(strip.prs);
  return (
    <section className={s.strip} aria-label={headline}>
      <button type="button" className={s.head} onClick={() => navigate(panelRoute(project, { tab: "agents", agent: null }))}>
        <Truncate expand="none" size="sm" tone="inherit">
          {headline}
        </Truncate>
      </button>
      {prs.length > 0 ? (
        <span className={s.prs}>
          <Text size="xs" tone="quiet">
            {prs.map((part, i) => {
              if (typeof part === "string") return part;
              const href = toHash(panelRoute(project, { tab: "prs", pr: { repo: null, number: part } }));
              return (
                <a key={i} className={s.pr} href={href}>
                  #{part}
                </a>
              );
            })}
          </Text>
        </span>
      ) : null}
    </section>
  );
}
