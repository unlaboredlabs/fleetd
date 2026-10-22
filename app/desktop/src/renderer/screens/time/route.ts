// The time inspector's place in the route table (notes/electron-routes.md): #/time, and #/time/order/<id>.
import { toHash } from "../shell/routes";

/** The inspector for one piece of work (its timeline), or the fleet. */
export const timeRoute = (order?: string): string => (order === undefined ? "#/time" : `#/time/order/${encodeURIComponent(order)}`);

/** The inspector at the scope you're looking at: one piece of work's timeline from a link to it, else the fleet. */
export const timeRouteFor = (hash: string): string => {
  const order = /^#\/(?:order|time\/order)\/([^/?]+)/u.exec(hash)?.[1];
  return order === undefined ? "#/time" : `#/time/order/${order}`;
};

/** Where one piece of work is opened from now: its project's lead chat (the order view is gone). Home without one. */
export const chatRoute = (project: { readonly machineId: string; readonly projectId: string } | undefined): string =>
  project === undefined ? "#/" : toHash({ id: "project", project: { machineId: project.machineId, projectId: project.projectId }, message: null });
