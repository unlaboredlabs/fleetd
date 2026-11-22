import type { Hub } from "../api/hub.ts";
import { trainArea } from "../train/index.ts";
import { GhIssues } from "./github.ts";
import { issueOrders } from "./index.ts";

/**
 * Starts issues as orders: GitHub through the train's reader, the follower of the train's events, and the poll of
 * every watched repo. `poll` false is fleetd's cloud, where GitHub's webhooks reach `issueOrders(hub).take` instead.
 */
export function start(hub: Hub, poll = true): void {
  const area = issueOrders(hub);
  area.github = new GhIssues(trainArea(hub).train.github);
  area.start(poll);
}
