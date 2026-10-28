// The time inspector's place in the route table (notes/electron-routes.md): Factory's Agent time tab,
// #/factory/time and #/factory/time/order/<id>.
import { parseHash, toHash } from "../shell/routes";

/** The inspector at the scope you're looking at: one piece of work's timeline from a link to it, else the fleet. */
export const timeRouteFor = (hash: string): string => {
  const screen = parseHash(hash);
  return toHash({ id: "time", orderId: screen.id === "time" ? screen.orderId : null });
};
