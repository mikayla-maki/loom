/**
 * Tests for `applyArgGrant` — the schema-narrowing + arg-binding
 * helper used by MCP-style provider tools (Chunk 5).
 */

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

describe("applyArgGrant", () => {
  it("`*` whole-tool grant leaves the schema and required list intact", () => {
    const a = applyArgGrant(docSchema, "*");
    expect(a.schema).toBe(docSchema);
    expect(a.bound).toEqual({});
    expect([...a.modelArgs].sort()).toEqual(["doc_id", "text"]);
  });

  it("undefined grant leaves the schema intact (no narrowing, no binding)", () => {
    const a = applyArgGrant(docSchema, undefined);
    expect(a.schema).toBe(docSchema);
    expect(a.bound).toEqual({});
    expect([...a.modelArgs].sort()).toEqual(["doc_id", "text"]);
  });

  it("literal-bound arg drops from properties + required and shows up in bound", () => {
    const a = applyArgGrant(docSchema, { doc_id: "doc-123" });
    const props = (a.schema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(props).sort()).toEqual(["text"]);
    expect((a.schema as { required: string[] }).required).toEqual(["text"]);
    expect(a.bound).toEqual({ doc_id: "doc-123" });
    expect([...a.modelArgs]).toEqual(["text"]);
    // additionalProperties metadata preserved.
    expect((a.schema as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it("numeric and boolean literals are also valid bindings", () => {
    const schema: JSONSchema = {
      type: "object",
      required: ["limit", "active"],
      properties: {
        limit: { type: "integer" },
        active: { type: "boolean" },
      },
    };
    const a = applyArgGrant(schema, { limit: 42, active: true });
    expect(
      (a.schema as { properties: Record<string, unknown> }).properties,
    ).toEqual({});
    expect((a.schema as { required?: string[] }).required).toBeUndefined();
    expect(a.bound).toEqual({ limit: 42, active: true });
  });

  it("array grant narrows a property to `enum`, preserving original metadata", () => {
    const schema: JSONSchema = {
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", description: "user state" },
      },
    };
    const a = applyArgGrant(schema, { status: ["online", "away"] });
    const status = (a.schema as { properties: { status: unknown } }).properties
      .status as Record<string, unknown>;
    expect(status.type).toBe("string");
    expect(status.description).toBe("user state");
    expect(status.enum).toEqual(["online", "away"]);
    // Still required (enum doesn't drop required).
    expect((a.schema as { required: string[] }).required).toEqual(["status"]);
    // Not bound — passed through from the model.
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
    const props = (a.schema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(props).sort()).toEqual(["limit", "status"]);
    expect((props.status as { enum: string[] }).enum).toEqual([
      "active",
      "pending",
    ]);
    expect((a.schema as { required: string[] }).required).toEqual(["status"]);
    expect(a.bound).toEqual({ table: "users" });
    expect([...a.modelArgs].sort()).toEqual(["limit", "status"]);
  });

  it("removing the only required arg deletes the `required` key entirely", () => {
    const schema: JSONSchema = {
      type: "object",
      required: ["only"],
      properties: { only: { type: "string" } },
    };
    const a = applyArgGrant(schema, { only: "fixed" });
    expect("required" in (a.schema as Record<string, unknown>)).toBe(false);
  });

  it("doesn't break when schema has no `properties` or `required`", () => {
    const schema: JSONSchema = { type: "object" };
    const a = applyArgGrant(schema, "*");
    expect(a.schema).toBe(schema);
    expect(a.modelArgs.size).toBe(0);
  });
});
