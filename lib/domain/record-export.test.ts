import { describe, expect, it } from "vitest";
import { buildExportTable, stringifyExportTable } from "./record-export";
import type { EntityRecord, FieldDefinition } from "./types";

function field(overrides: Partial<FieldDefinition> & Pick<FieldDefinition, "id" | "name" | "type">): FieldDefinition {
  return {
    workspaceId: "w1",
    entityTypeId: "e1",
    key: `fld_${overrides.id}`,
    slug: overrides.name.toLowerCase(),
    required: false,
    position: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function record(values: EntityRecord["values"]): EntityRecord {
  return {
    id: "r1",
    workspaceId: "w1",
    entityTypeId: "e1",
    values,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("buildExportTable", () => {
  it("uses field names, in field order, as the header row", () => {
    const nameField = field({ id: "f1", name: "Name", type: "text", position: 1 });
    const revenueField = field({ id: "f2", name: "Revenue", type: "number", position: 2 });

    const table = buildExportTable({ fields: [nameField, revenueField], records: [] });
    expect(table).toEqual([["Name", "Revenue"]]);
  });

  it("passes text and number values through unchanged", () => {
    const nameField = field({ id: "f1", name: "Name", type: "text" });
    const revenueField = field({ id: "f2", name: "Revenue", type: "number" });

    const table = buildExportTable({
      fields: [nameField, revenueField],
      records: [record({ [nameField.key]: "Acme", [revenueField.key]: 4200000 })],
    });
    expect(table[1]).toEqual(["Acme", "4200000"]);
  });

  it("exports the stored YYYY-MM-DD date string unchanged", () => {
    const dateField = field({ id: "f1", name: "Start Date", type: "date" });
    const table = buildExportTable({ fields: [dateField], records: [record({ [dateField.key]: "2026-03-04" })] });
    expect(table[1]).toEqual(["2026-03-04"]);
  });

  it("exports booleans as the literal true/false import already accepts", () => {
    const activeField = field({ id: "f1", name: "Active", type: "boolean" });
    const table = buildExportTable({
      fields: [activeField],
      records: [record({ [activeField.key]: true }), record({ [activeField.key]: false })],
    });
    expect(table[1]).toEqual(["true"]);
    expect(table[2]).toEqual(["false"]);
  });

  it("exports null/undefined values as an empty cell, for every field type", () => {
    const nameField = field({ id: "f1", name: "Name", type: "text" });
    const revenueField = field({ id: "f2", name: "Revenue", type: "number" });
    const activeField = field({ id: "f3", name: "Active", type: "boolean" });
    const dateField = field({ id: "f4", name: "Start Date", type: "date" });

    const table = buildExportTable({
      fields: [nameField, revenueField, activeField, dateField],
      records: [record({ [nameField.key]: null, [revenueField.key]: null, [activeField.key]: null, [dateField.key]: null })],
    });
    expect(table[1]).toEqual(["", "", "", ""]);
  });

  it("exports a relation cell's already-resolved label as-is (label resolution happens upstream)", () => {
    const clientField = field({ id: "f1", name: "Client", type: "relation", relatedEntityTypeId: "et2" });
    const table = buildExportTable({
      fields: [clientField],
      records: [record({ [clientField.key]: "Acme Corp" })],
    });
    expect(table[1]).toEqual(["Acme Corp"]);
  });

  it("exports an empty relation cell as an empty string", () => {
    const clientField = field({ id: "f1", name: "Client", type: "relation", relatedEntityTypeId: "et2" });
    const table = buildExportTable({ fields: [clientField], records: [record({ [clientField.key]: null })] });
    expect(table[1]).toEqual([""]);
  });
});

describe("CSV serialization (RFC 4180 escaping via csv-stringify)", () => {
  it("quotes a value containing a comma", () => {
    const nameField = field({ id: "f1", name: "Name", type: "text" });
    const table = buildExportTable({ fields: [nameField], records: [record({ [nameField.key]: "Acme, Inc." })] });
    const csv = stringifyExportTable(table);
    expect(csv).toBe('Name\r\n"Acme, Inc."\r\n');
  });

  it("escapes an embedded double quote by doubling it", () => {
    const nameField = field({ id: "f1", name: "Name", type: "text" });
    const table = buildExportTable({ fields: [nameField], records: [record({ [nameField.key]: 'Say "hi"' })] });
    const csv = stringifyExportTable(table);
    expect(csv).toBe('Name\r\n"Say ""hi"""\r\n');
  });

  it("quotes a value containing an embedded newline", () => {
    const nameField = field({ id: "f1", name: "Name", type: "text" });
    const table = buildExportTable({ fields: [nameField], records: [record({ [nameField.key]: "Line one\nLine two" })] });
    const csv = stringifyExportTable(table);
    expect(csv).toBe('Name\r\n"Line one\nLine two"\r\n');
  });
});
