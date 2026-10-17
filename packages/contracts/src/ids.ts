import { Schema } from "effect";

/** Stable machine id chosen at enrollment, e.g. "forge". */
export const MachineId = Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,32}$/u)).pipe(
  Schema.brand("MachineId"),
  Schema.annotate({ identifier: "MachineId", description: "Machine slug, [a-z0-9-]{1,32}" }),
);
export type MachineId = typeof MachineId.Type;

/** T3's project id on one machine. Only unique together with a MachineId. */
export const ProjectId = Schema.NonEmptyString.pipe(Schema.brand("ProjectId"), Schema.annotate({ identifier: "ProjectId" }));
export type ProjectId = typeof ProjectId.Type;

/** T3's thread id on one machine. Only unique together with a MachineId. */
export const ThreadId = Schema.NonEmptyString.pipe(Schema.brand("ThreadId"), Schema.annotate({ identifier: "ThreadId" }));
export type ThreadId = typeof ThreadId.Type;

export const ProjectRef = Schema.Struct({ machineId: MachineId, projectId: ProjectId });
export type ProjectRef = typeof ProjectRef.Type;

export const ThreadRef = Schema.Struct({ machineId: MachineId, threadId: ThreadId });
export type ThreadRef = typeof ThreadRef.Type;

/** ISO 8601 UTC timestamp string. */
export const Timestamp = Schema.String.annotate({ identifier: "Timestamp", format: "date-time" });
export type Timestamp = typeof Timestamp.Type;

/** Hub-global event sequence number; also the events cursor. */
export const EventSeq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ identifier: "EventSeq" });
export type EventSeq = typeof EventSeq.Type;
