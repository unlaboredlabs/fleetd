// Ports crates/fleetd/src/hub/hub_links/serve.rs (/link/v1/{op}); authenticate with ../auth/http.ts.
import { NotImplemented } from "../../shared/errors.ts";
import type { Route } from "../http/route.ts";

export const hubLink: Route = () => {
  throw new NotImplemented("src/hub/hub_links/serve: hubLink");
};
