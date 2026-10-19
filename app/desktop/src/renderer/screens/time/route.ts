// The time inspector's place in the route table (notes/electron-routes.md): #/time, and #/time/order/<id>.

/** The inspector for one order (its timeline), or the fleet. The order view's Time button opens this. */
export const timeRoute = (order?: string): string => (order === undefined ? "#/time" : `#/time/order/${encodeURIComponent(order)}`);

/** The inspector at the scope you're looking at: an order's timeline from anything about that order, else the fleet. */
export const timeRouteFor = (hash: string): string => {
  const order = /^#\/(?:order|status\/order|time\/order)\/([^/?]+)/u.exec(hash)?.[1];
  return order === undefined ? "#/time" : `#/time/order/${order}`;
};

/** The order view, at a transcript item when one is given (#/order/<id>?thread=&item=). */
export const orderRoute = (order: string, at?: { readonly threadId: string; readonly itemId: string }): string => {
  const q = at === undefined ? "" : `?${new URLSearchParams({ thread: at.threadId, item: at.itemId }).toString()}`;
  return `#/order/${encodeURIComponent(order)}${q}`;
};
