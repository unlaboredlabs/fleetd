// Ports crates/fleetd/src/hub/pair (POST /pair, POST /pair/mac).
import { NotImplemented } from "../../shared/errors.ts";
import type { Route } from "../http/route.ts";

export const pair: Route = () => {
  throw new NotImplemented("src/hub/pair/http: pair");
};

export const macPair: Route = () => {
  throw new NotImplemented("src/hub/pair/http: macPair");
};
