// The time inspector's place in the route table (notes/electron-routes.md): #/time, and #/time/order/<id>.

/** The inspector at the scope you're looking at: one piece of work's timeline from a link to it, else the fleet. */
export const timeRouteFor = (hash: string): string => {
  const order = /^#\/time\/order\/([^/?]+)/u.exec(hash)?.[1];
  return order === undefined ? "#/time" : `#/time/order/${order}`;
};
