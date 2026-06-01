import { describe, expect, it } from "vitest";

import { applyArgGrant } from "../src/manifest/capabilities.js";
import type { JSONSchema } from "../src/types/schema.js";

const docSchema: JSONSchema = {
  type: "object",
  required: ["doc_id", "text"],
  properties: {
    doc_id: { type: "string" },
    text: { type: "string" },
  },
  additionalProperties: false,
};

const props = (s: JSONSchema) =>
  (s as { properties?: Record<string, unknown> }).properties;
const required = (s: JSONSchema) => (s as { required?: string[] }).required;
const hasRequired = (s: JSONSchema) => "required" in (s as Record<string, unknown>);

describe("applyArgGrant", () => {
  it("`*` and undefined whole-tool grants leave the schema and required list intact", () => {
    for (const grant of ["*" as const, undefined]) {
      const a = applyArgGrant(docSchema, grant);
      expect(a.schema).toBe(docSchema);
      expect(a.bound).toEqual({});
      expect([...a.modelArgs].sort()).toEqual(["doc_id", "text"]);
    }
  });

  it("literal-bound arg drops from properties + required, lands in bound, and keeps additionalProperties", () => {
    const a = applyArgGrant(docSchema, { doc_id: "doc-123", text: "*" });
    expect(Object.keys(props(a.schema)!).sort()).toEqual(["text"]);
    expect(required(a.schema)).toEqual(["text"]);
    expect(a.bound).toEqual({ doc_id: "doc-123" });
    expect([...a.modelArgs]).toEqual(["text"]);
    expect(
      (a.schema as { additionalProperties: boolean }).additionalProperties,
    ).toBe(false);
  });

  it("numeric and boolean literals are valid bindings", () => {
    const schema: JSONSchema = {
      type: "object",
      required: ["limit", "active"],
      properties: {
        limit: { type: "integer" },
        active: { type: "boolean" },
      },
    };
    const a = applyArgGrant(schema, { limit: 42, active: true });
    expect(props(a.schema)).toEqual({});
    expect(required(a.schema)).toBeUndefined();
    expect(a.bound).toEqual({ limit: 42, active: true });
  });

  it("array grant narrows a property to enum, preserving metadata and required, without binding", () => {
    const schema: JSONSchema = {
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", description: "user state" },
      },
    };
    const a = applyArgGrant(schema, { status: ["online", "away"] });
    const status = (props(a.schema) as { status: Record<string, unknown> })
      .status;
    expect(status.type).toBe("string");
    expect(status.description).toBe("user state");
    expect(status.enum).toEqual(["online", "away"]);
    expect(required(a.schema)).toEqual(["status"]);
    expect(a.bound).toEqual({});
    expect([...a.modelArgs]).toEqual(["status"]);
  });

  it("per-arg `*` leaves the arg unchanged", () => {
    const a = applyArgGrant(docSchema, { doc_id: "*", text: "*" });
    expect(a.schema).toMatchObject({
      properties: { doc_id: { type: "string" }, text: { type: "string" } },
      required: ["doc_id", "text"],
    });
    expect(a.bound).toEqual({});
  });

  it("per-arg map is a whitelist: unlisted args drop from properties and required", () => {
    const schema: JSONSchema = {
      type: "object",
      required: ["a", "c"],
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
      },
    };
    const a = applyArgGrant(schema, { a: "*", b: "*" });
    expect(Object.keys(props(a.schema)!).sort()).toEqual(["a", "b"]);
    expect(required(a.schema)).toEqual(["a"]);
    expect([...a.modelArgs].sort()).toEqual(["a", "b"]);
    expect(a.bound).toEqual({});
  });

  it("empty per-arg map drops every advertised arg and the required key", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
      },
    };
    const a = applyArgGrant(schema, {});
    expect(props(a.schema)).toEqual({});
    expect(hasRequired(a.schema)).toBe(false);
    expect(a.modelArgs.size).toBe(0);
    expect(a.bound).toEqual({});
  });

  it("mixed grant: one bound, one enum-narrowed, one passthrough", () => {
    const schema: JSONSchema = {
      type: "object",
      required: ["table", "status"],
      properties: {
        table: { type: "string" },
        status: { type: "string" },
        limit: { type: "integer" },
      },
    };
    const a = applyArgGrant(schema, {
      table: "users",
      status: ["active", "pending"],
      limit: "*",
    });
    expect(Object.keys(props(a.schema)!).sort()).toEqual(["limit", "status"]);
    expect(
      (props(a.schema) as { status: { enum: string[] } }).status.enum,
    ).toEqual(["active", "pending"]);
    expect(required(a.schema)).toEqual(["status"]);
    expect(a.bound).toEqual({ table: "users" });
    expect([...a.modelArgs].sort()).toEqual(["limit", "status"]);
  });

  it("removing the only required arg deletes the required key entirely", () => {
    const schema: JSONSchema = {
      type: "object",
      required: ["only"],
      properties: { only: { type: "string" } },
    };
    const a = applyArgGrant(schema, { only: "fixed" });
    expect(hasRequired(a.schema)).toBe(false);
  });

  it("doesn't break when schema has no properties or required", () => {
    const schema: JSONSchema = { type: "object" };
    const a = applyArgGrant(schema, "*");
    expect(a.schema).toBe(schema);
    expect(a.modelArgs.size).toBe(0);
  });
});
