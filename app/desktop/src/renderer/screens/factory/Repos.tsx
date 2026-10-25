// The projects table, under "All projects": one row per repo with the four numbers and its trend, the cross-fleet
// comparison (past four projects a table reads better than small multiples). A repo checked out by two projects is
// one row, and says where else it lives. A row opens the screen on its first project.
import type { MetricsRepoRow } from "../../../shared/contracts";
import { Text, Truncate, cx } from "../../ui";
import { fmtAbout, fmtCount, fmtMs, fmtPct, repoName, sparkPath, sparkValues } from "./model";
import s from "./Factory.module.css";

export interface ReposProps {
  readonly rows: readonly MetricsRepoRow[];
  /** A project's title, else its id. */
  readonly projectTitle: (ref: MetricsRepoRow["projects"][number]) => string;
  readonly projectHref: (ref: MetricsRepoRow["projects"][number]) => string;
}

function Trend({ row }: { row: MetricsRepoRow }) {
  const { d, last } = sparkPath(sparkValues(row.spark), 72, 20);
  if (d === "") return <Text size="xs" tone="quiet">—</Text>;
  return (
    <svg className={cx(s.spark)} width={72} height={20} aria-hidden>
      <path className={cx(s.sparkLine)} d={d} />
      {last !== undefined ? <circle className={cx(s.sparkNow)} style={{ stroke: "var(--bg)" }} cx={last.x} cy={last.y} r={3} /> : null}
    </svg>
  );
}

export function Repos({ rows, projectTitle, projectHref }: ReposProps) {
  return (
    <section className={cx(s.section)} aria-labelledby="factory-repos">
      <div className={cx(s.sectionHead)}>
        <Text as="h2" strong id="factory-repos">
          Projects
        </Text>
        <Text size="xs" tone="quiet">
          One row per repo: a repo checked out on two machines counts once.
        </Text>
      </div>
      <div className={cx(s.tableWrap)}>
        <table className={cx(s.table)}>
          <colgroup>
            <col style={{ width: "30%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "15%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "16%" }} />
          </colgroup>
          <thead>
            <tr>
              {["Repo", "Merged per day", "Order to merged", "Your minutes per PR", "Through fleetd", "Merged, by slice"].map((h, i) => (
                <th key={h} className={cx(i > 0 && i < 5 && s.num)}>
                  <Truncate size="xs" tone="quiet" expand="none">
                    {h}
                  </Truncate>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const [first, ...others] = r.projects;
              return (
                <tr key={r.repo}>
                  <td>
                    <span className={cx(s.cell)}>
                      {first !== undefined ? (
                        <a href={projectHref(first)}>
                          <Truncate size="xs" strong expand="none">
                            {repoName(r.repo)}
                          </Truncate>
                        </a>
                      ) : (
                        <Truncate size="xs" strong>
                          {repoName(r.repo)}
                        </Truncate>
                      )}
                      {others.length > 0 ? (
                        <Truncate size="xs" tone="quiet">
                          {`also checked out as ${others.map(projectTitle).join(", ")}`}
                        </Truncate>
                      ) : null}
                    </span>
                  </td>
                  <td className={cx(s.num)}>
                    <Text size="xs" tabular>{`${fmtCount(r.mergedPerDay)} (${fmtCount(r.n)})`}</Text>
                  </td>
                  <td className={cx(s.num)}>
                    <Text size="xs" tabular>
                      {r.orderToMergedMedianMs === undefined ? "—" : fmtMs(r.orderToMergedMedianMs)}
                    </Text>
                  </td>
                  <td className={cx(s.num)}>
                    <Text size="xs" tabular>
                      {r.humanPerPrMs === undefined ? "—" : fmtAbout(r.humanPerPrMs)}
                    </Text>
                  </td>
                  <td className={cx(s.num)}>
                    <Text size="xs" tabular>
                      {r.throughFleetdPct === undefined ? "—" : fmtPct(r.throughFleetdPct)}
                    </Text>
                  </td>
                  <td>
                    <Trend row={r} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
