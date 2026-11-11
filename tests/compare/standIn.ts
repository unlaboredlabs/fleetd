// A stand-in target with many teams, to prove the two-team cases (twoTeams.ts) where no such service runs: a few
// tools over things in boxes and named notes, served on /mcp from one address, the team taken from the key as a
// shared service takes it. Its ids are the shapes the real ones have: a thing's is random and unique everywhere, a
// box's is a number each team counts for itself (both teams have a B1), a note's is a name the team chose.
//
// `leak` breaks the wall on purpose, the ways a real one breaks: `row` reads a thing whoever's it is, `forbidden`
// finds another team's thing and refuses it (so the caller learns it exists), `list` lists every team's things,
// `ids` lists them too but with another team's titles blanked: its ids and nothing a canary is in.
// Imports nothing of the lab's: fleetd's own tests start it.
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Schema } from "./mcp.ts";
import type { Target, Team } from "./target.ts";
import type { Contract } from "./twoTeams.ts";

export type Leak = "row" | "forbidden" | "list" | "ids";

interface Thing {
  readonly thingId: string;
  readonly boxId: string;
  title: string;
}

export interface StandInTeam {
  /** In every title and text of the team's rows: what another team must never be shown. */
  readonly canary: string;
  readonly boxes: Array<string>;
  readonly things: Array<Thing>;
  readonly notes: Map<string, string>;
}

export interface StandInTool {
  readonly name: string;
  readonly readOnly: boolean;
  /** Its input and output, as McpTools.json would hold them; ids are `$ref`s into the stand-in's types (DEFS). */
  readonly input: Schema;
  readonly output: Schema;
  /** Answers for `team`; `all` is every team, which only a leak reads. Refuses by throwing a Refusal. */
  readonly run: (team: StandInTeam, input: any, all: ReadonlyArray<StandInTeam>) => unknown;
}

export class Refusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const ref = (type: string) => ({ $ref: `#/$defs/${type}` });
const object = (properties: Record<string, Schema>, optional: ReadonlyArray<string> = []) => ({ type: "object", properties, required: Object.keys(properties).filter((k) => !optional.includes(k)) });
const DEFS: Record<string, Schema> = {
  ThingId: { type: "string", pattern: "^t_[0-9a-f]{8}$" },
  BoxId: { type: "string", pattern: "^B[1-9][0-9]*$" },
  NoteName: { type: "string", pattern: "^[a-z0-9-]{1,32}$" },
  BoxRef: object({ boxId: ref("BoxId") }),
  Thing: object({ thingId: ref("ThingId"), boxId: ref("BoxId"), title: { type: "string" } }),
  Note: object({ name: ref("NoteName"), text: { type: "string" } }),
};

function tools(leak: Leak | undefined): Array<StandInTool> {
  const thing = (team: StandInTeam, all: ReadonlyArray<StandInTeam>, thingId: string) => {
    const found = (leak === "row" ? all : [team]).flatMap((t) => t.things).find((t) => t.thingId === thingId);
    if (found !== undefined) return found;
    if (leak === "forbidden" && all.some((t) => t.things.some((x) => x.thingId === thingId))) throw new Refusal("forbidden", `Thing ${thingId} belongs to another team.`);
    throw new Refusal("not_found", `No thing ${thingId}.`);
  };
  const note = (team: StandInTeam, name: string) => ({ name, text: team.notes.get(name)! });
  return [
    { name: "team_get", readOnly: true, input: object({}), output: object({ boxes: { type: "integer" } }), run: (team) => ({ boxes: team.boxes.length }) },
    { name: "boxes_list", readOnly: true, input: object({}), output: object({ boxes: { type: "array", items: ref("BoxRef") } }), run: (team) => ({ boxes: team.boxes.map((boxId) => ({ boxId })) }) },
    {
      name: "things_list",
      readOnly: true,
      input: object({}),
      output: object({ things: { type: "array", items: ref("Thing") } }),
      run: (team, _input, all) => ({ things: (leak === "list" || leak === "ids" ? all : [team]).flatMap((t) => (leak === "ids" && t !== team ? t.things.map((x) => ({ ...x, title: "" })) : t.things)) }),
    },
    { name: "thing_get", readOnly: true, input: object({ thingId: ref("ThingId") }), output: object({ thing: ref("Thing") }), run: (team, input, all) => ({ thing: thing(team, all, input.thingId) }) },
    {
      name: "thing_rename",
      readOnly: false,
      input: object({ thingId: ref("ThingId"), title: { type: "string", minLength: 1 } }),
      output: object({ thing: ref("Thing") }),
      run: (team, input, all) => {
        const found = thing(team, all, input.thingId);
        found.title = input.title;
        return { thing: found };
      },
    },
    {
      name: "box_things",
      readOnly: true,
      input: object({ boxRef: ref("BoxRef"), thingId: ref("ThingId") }, ["thingId"]),
      output: object({ things: { type: "array", items: ref("Thing") } }),
      run: (team, input, all) => {
        if (!team.boxes.includes(input.boxRef.boxId)) throw new Refusal("not_found", `No box ${input.boxRef.boxId}.`);
        const inBox = team.things.filter((t) => t.boxId === input.boxRef.boxId);
        return { things: input.thingId === undefined ? inBox : [thing(team, all, input.thingId)].filter((t) => inBox.includes(t)) };
      },
    },
    { name: "notes_list", readOnly: true, input: object({}), output: object({ notes: { type: "array", items: ref("Note") } }), run: (team) => ({ notes: [...team.notes.keys()].map((name) => note(team, name)) }) },
    {
      name: "note_get",
      readOnly: true,
      input: object({ name: ref("NoteName") }),
      output: object({ note: ref("Note") }),
      run: (team, input) => {
        if (!team.notes.has(input.name)) throw new Refusal("not_found", `No note ${input.name}.`);
        return { note: note(team, input.name) };
      },
    },
    {
      // Makes the note when the team has none of that name: a name another team uses is free here.
      name: "note_set",
      readOnly: false,
      input: object({ name: ref("NoteName"), text: { type: "string" } }),
      output: object({ note: ref("Note") }),
      run: (team, input) => {
        team.notes.set(input.name, input.text);
        return { note: note(team, input.name) };
      },
    },
  ];
}

export interface StandIn extends Target {
  /** Its tools' schemas, in McpTools.json's layout. */
  readonly contract: Contract;
  /** A team made here, by the address-and-key it was handed out as. */
  readonly data: (team: Team) => StandInTeam;
}

/** Starts the stand-in on a free local port. `tools` are added to its list: what a new tool is to the real one. */
export async function standIn(opts: { readonly leak?: Leak; readonly tools?: ReadonlyArray<StandInTool> } = {}): Promise<StandIn> {
  const list = [...tools(opts.leak), ...(opts.tools ?? [])];
  const teams: Array<StandInTeam> = [];
  const byKey = new Map<string, StandInTeam>();
  const made = new Map<Team, StandInTeam>();
  const result = (value: unknown, isError: boolean) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError });

  const answer = (team: StandInTeam, method: string, params: Record<string, any>): unknown => {
    if (method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "0" } };
    if (method === "tools/list") return { tools: list.map((t) => ({ name: t.name, description: "", inputSchema: { ...t.input, $defs: DEFS }, annotations: { readOnlyHint: t.readOnly } })) };
    const tool = list.find((t) => t.name === params.name);
    if (method !== "tools/call" || tool === undefined) throw new Error(`no ${method} ${params.name ?? ""}`);
    try {
      return result(tool.run(team, params.arguments ?? {}, teams), false);
    } catch (e) {
      if (e instanceof Refusal) return result({ code: e.code, message: e.message }, true);
      throw e;
    }
  };

  const server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const team = byKey.get((req.headers.authorization ?? "").replace(/^Bearer /u, ""));
      if (req.method !== "POST" || req.url !== "/mcp" || team === undefined) return void res.writeHead(team === undefined ? 401 : 404).end();
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: Record<string, any> };
      if (call.id === undefined) return void res.writeHead(202).end();
      let body: Record<string, unknown>;
      try {
        body = { jsonrpc: "2.0", id: call.id, result: answer(team, call.method, call.params ?? {}) };
      } catch (e) {
        body = { jsonrpc: "2.0", id: call.id, error: { code: -32602, message: e instanceof Error ? e.message : String(e) } };
      }
      res.writeHead(200, { "content-type": "application/json", ...(call.method === "initialize" ? { "mcp-session-id": randomBytes(8).toString("hex") } : {}) }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    name: "stand-in",
    teams: Infinity,
    contract: { $defs: { ...DEFS, McpTools: { type: "object", properties: Object.fromEntries(list.flatMap((t) => [[`${t.name}.input`, t.input], [`${t.name}.output`, t.output]])) } } },
    data: (team) => made.get(team)!,
    team: async () => {
      // Each team a box more than the one before, so the later one holds a box number the earlier lacks.
      const canary = `canary-${randomBytes(6).toString("hex")}`;
      const boxes = Array.from({ length: teams.length + 1 }, (_, n) => `B${n + 1}`);
      const data: StandInTeam = {
        canary,
        boxes,
        things: boxes.map((boxId) => ({ thingId: `t_${randomBytes(4).toString("hex")}`, boxId, title: `${canary} in ${boxId}` })),
        notes: new Map([
          ["welcome", `${canary} welcome`],
          [`notes-${randomBytes(4).toString("hex")}`, `${canary} of its own`],
        ]),
      };
      teams.push(data);
      const team: Team = {
        url,
        key: async () => {
          const key = `standin_${randomBytes(12).toString("hex")}`;
          byKey.set(key, data);
          return key;
        },
        enrol: async () => {
          throw new Error("the stand-in has no machines");
        },
      };
      made.set(team, data);
      return team;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
