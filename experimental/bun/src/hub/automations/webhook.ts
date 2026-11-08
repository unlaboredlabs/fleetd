// Ports crates/fleetd/src/hub/automations/webhook.rs (POST /hooks/{automation_id}/{secret}).
import { NotImplemented } from "../../shared/errors.ts";
import type { Route } from "../http/route.ts";

export const hook: Route = () => {
  throw new NotImplemented("src/hub/automations/webhook: hook");
};
