export type JsonValue = string | number | boolean | null | JsonArray | JsonObject;
export type JsonArray = Array<JsonValue>;
export interface JsonObject {
  [key: string]: JsonValue;
}

export const isObject = (v: JsonValue | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** A deep copy, so a fixture built from another never shares (and mutates) its objects. */
export const clone = <T extends JsonValue>(v: T): T => structuredClone(v);

/** `v` when it is a string, else `fallback`: for reading fields of untyped hub JSON. */
export const asText = (v: JsonValue | undefined, fallback = ""): string => (typeof v === "string" ? v : fallback);
