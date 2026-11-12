// The hub link tools. On the hub whose projects a link reaches, a person
// mints and revokes links (their own; an admin anyone's). On the hub with the project, a person adds a link to a project,
// its key sealed to this hub, and removes it.
import type { ProjectRef } from "../../shared/contracts.ts";
import { internalError, ToolError } from "../../shared/errors.ts";
import { openSealed, publicKeyOf, seal } from "../../shared/sealed_box.ts";
import { isBase64 } from "../../shared/text.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { unknownProject } from "../api/refusals.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { announce, change } from "../people/events.ts";
import { allowsEverywhere } from "../people/tools.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { askBridge } from "./bridge.ts";
import { follow, hello as helloThere, revokeThere } from "./client.ts";
import { personOnly } from "./links.ts";
import { boxKey, checkUrl, forget, issued, issuedGet, keep, kept, keptGet, keptInfo, mint, revokeIssued, setHello } from "./store.ts";

const B64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function boxFailed(error: unknown): ToolError {
  console.error("hub box key:", error);
  return new ToolError("failed", "The hub can't read its box key.", "Check the hub's home directory is writable, then try again.");
}

function box(hub: Hub): Uint8Array {
  try {
    return boxKey(hub);
  } catch (error) {
    throw boxFailed(error);
  }
}

const refOf = (input: { project?: ProjectRef }) => input.project;

export function register(tools: Registry): void {
  tools.add("hub_links_get", (hub, caller, input) => {
    const project = refOf(input);
    let links: ReturnType<typeof keptInfo>[] = [];
    if (project) {
      requireRole(caller, "read", project.machineId);
      links = kept(hub.db, project).map(keptInfo);
    }
    const mine = allowsEverywhere(caller, "admin")
      ? undefined
      : { keyId: caller.keyId, ...(caller.person === undefined ? {} : { person: caller.person }) };
    return { boxPubKey: B64(publicKeyOf(box(hub))), issued: issued(hub.db, mine), links };
  });

  tools.add("hub_link_mint", (hub, caller, input) => {
    // The registry already refused a device that operates nowhere: a link never holds more than its device.
    personOnly(caller);
    if (input.projects !== undefined) {
      if (input.projects.length === 0) {
        throw new ToolError(
          "invalid",
          "A link limited to no project reaches nothing.",
          "Name at least one project, or leave projects out for all of yours.",
        );
      }
      for (const p of input.projects) {
        if (!store(hub).projectGet(p)) throw unknownProject(p);
        requireRole(caller, "operate", p.machineId);
      }
    }
    const { link, key } = mint(hub, caller, input.label, input.projects);
    return {
      key,
      link,
      next:
        "Shown once: paste it into the other hub's project, Linked hubs. It acts as you on this hub, at the " +
        "lesser of your role here and this device's grants, never above operate; revoke it here at any time.",
    };
  });

  tools.add("hub_link_revoke", (hub, caller, input) => {
    personOnly(caller);
    const notFound = () => new ToolError("not_found", `No link ${input.linkId} on this hub.`, "hub_links_get lists yours.");
    const link = issuedGet(hub.db, input.linkId);
    if (!link) throw notFound();
    const own =
      link.keyId === caller.keyId || (caller.person !== undefined && link.person?.personId === caller.person.personId);
    if (!own && !allowsEverywhere(caller, "admin")) throw notFound();
    const person = link.person ?? caller.person;
    if (revokeIssued(hub, input.linkId) && person) {
      // Every open app's lists of links read again: its person's, and an admin's of everyone's.
      announce(hub, change("link_revoked", person, caller.person), `A hub link of ${person.name} was revoked`);
    }
    const after = issuedGet(hub.db, input.linkId);
    if (!after) throw notFound();
    return { link: after, next: "Revoked: its next request is refused." };
  });

  tools.add("hub_link_add", async (hub, caller, input) => {
    personOnly(caller);
    const project = refOf(input) as ProjectRef;
    requireRole(caller, "operate", project.machineId);
    if (!store(hub).projectGet(project)) throw unknownProject(project);
    askBridge(hub).mayUse(project);
    const url = checkUrl(input.url).href.replace(/\/+$/, "");
    if (!isBase64(input.sealed)) throw new ToolError("invalid", "sealed is not base64.");
    const sealedIn = Buffer.from(input.sealed, "base64");
    const key = box(hub);
    let pasted: string | undefined;
    try {
      const plain = openSealed(key, sealedIn);
      pasted = plain ? new TextDecoder("utf-8", { fatal: true }).decode(plain) : undefined;
    } catch {
      pasted = undefined;
    }
    if (pasted === undefined) throw new ToolError("invalid", "The key wasn't sealed to this hub.", "Seal it to boxPubKey from hub_links_get.");
    // A pasted key often carries a newline: the hub keeps it trimmed, sealed again to itself.
    const linkKey = pasted.trim();
    const sealed = seal(publicKeyOf(key), new TextEncoder().encode(linkKey));
    const hello = await helloThere(input.label, url, linkKey);
    const linkId = keep(hub, project, input.label, url, sealed, hello.cursor);
    if (linkId === undefined) {
      throw new ToolError(
        "invalid",
        `This project has a linked hub called ${input.label} already.`,
        "Pick another label, or remove that link first.",
      );
    }
    // The link is kept: from here on nothing fails the add, so it is never kept without its follower.
    try {
      setHello(hub.db, linkId, hello);
    } catch (error) {
      console.warn(`hub link ${linkId} hello:`, error);
    }
    // The hello just read is fresh: the follower doesn't read it again.
    void follow(hub, linkId, false);
    const added = keptGet(hub.db, linkId);
    if (!added) throw internalError();
    return {
      link: keptInfo(added),
      next: `The lead reaches ${hello.projects.length} project(s) on ${input.label}: factory_status and project_message with hub "${input.label}".`,
      projects: hello.projects,
    };
  });

  tools.add("hub_link_remove", async (hub, caller, input) => {
    personOnly(caller);
    const link = keptGet(hub.db, input.linkId);
    if (!link) {
      throw new ToolError("not_found", `No linked hub ${input.linkId} here.`, "hub_links_get with the project lists its links.");
    }
    // Anyone who operates on the project's machine changes its links (D491).
    requireRole(caller, "operate", link.project.machineId);
    // The key goes first, so nothing more goes through it; then the other hub is asked to revoke it too.
    forget(hub.db, link.linkId);
    // crates/fleetd/src/hub/projects/settings.rs `announce`.
    events(hub).append({
      at: isoMs(hub.clock.now()),
      type: "project.settings",
      machineId: link.project.machineId,
      projectId: link.project.projectId,
      summary: `${link.label} unlinked`,
      data: { hubLinkRemoved: link.linkId },
    });
    const revokedThere = await revokeThere(hub, link);
    return {
      ...(revokedThere
        ? {}
        : { next: `${link.label} didn't answer, so the link still shows there until someone revokes it; it can't be used.` }),
      revokedThere,
    };
  });
}
